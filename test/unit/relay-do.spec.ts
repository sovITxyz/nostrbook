// PR2 packet 3: RelayCore — the RelayDO's testable protocol engine, driven
// directly (no sockets, no DO instance; the workerd cross-context
// WebSocketPair hang-detection gotcha never applies). env comes from the
// workers pool (real miniflare D1/KV with migrations applied), the SubsStore
// is an in-memory stub, and events are signed with the committed throwaway
// fixture keys.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALICE_PK,
  ALICE_SK,
  BOB_PK,
  BOB_SK,
  MALLORY_PK,
  MALLORY_SK,
  resetMirrorState,
  resetRateLimits,
  resetUsers,
  seedAlice,
  seedBlockedMallory,
  signDeleteEvent,
  signLoginEvent,
  signPostEvent,
} from "../helpers";
import { mirrorEvent } from "../../src/services/mirror";
import type { NostrEvent } from "../../src/nostr/event";
import {
  ALLOWLIST_CACHE_SECONDS,
  EVENT_PK_MAX,
  EVENT_PK_WINDOW_SECONDS,
  GLOBAL_STORE_MAX,
  GLOBAL_STORE_WINDOW_SECONDS,
  MAX_AUTH_ATTEMPTS,
  MAX_MESSAGES_PER_MINUTE,
  RelayCore,
  type ConnState,
  type SubRow,
  type SubsStore,
} from "../../src/relay/do";

// --- Test doubles ---------------------------------------------------------------

/** In-memory SubsStore (the DO uses its SQLite; the core doesn't care). */
class MemStore implements SubsStore {
  private rows = new Map<string, Map<string, string>>();

  countOther(connId: string, subId: string): number {
    const conn = this.rows.get(connId);
    if (conn === undefined) return 0;
    let n = 0;
    for (const k of conn.keys()) if (k !== subId) n += 1;
    return n;
  }
  put(connId: string, subId: string, filtersJson: string): void {
    let conn = this.rows.get(connId);
    if (conn === undefined) {
      conn = new Map();
      this.rows.set(connId, conn);
    }
    conn.set(subId, filtersJson);
  }
  delete(connId: string, subId: string): void {
    this.rows.get(connId)?.delete(subId);
  }
  deleteConn(connId: string): void {
    this.rows.delete(connId);
  }
  all(): SubRow[] {
    const out: SubRow[] = [];
    for (const [conn_id, subs] of this.rows) {
      for (const [sub_id, filters] of subs) out.push({ conn_id, sub_id, filters });
    }
    return out;
  }
  count(connId: string): number {
    return this.rows.get(connId)?.size ?? 0;
  }
  get(connId: string, subId: string): string | undefined {
    return this.rows.get(connId)?.get(subId);
  }
}

function makeConn(over: Partial<ConnState> = {}): ConnState {
  return {
    connId: crypto.randomUUID(),
    challenge: "ab".repeat(32),
    authedPubkey: null,
    allowedUntil: 0,
    ...over,
  };
}

function makeCore(store = new MemStore(), now?: () => number) {
  return { core: new RelayCore(env, store, now), store };
}

/** Parse an outbound frame back into its tuple for assertions. */
const parse = (frame: string): unknown[] => JSON.parse(frame) as unknown[];

const send = (
  core: RelayCore,
  conn: ConnState,
  msg: unknown[],
): ReturnType<RelayCore["handleMessage"]> =>
  core.handleMessage(conn, JSON.stringify(msg));

/** AUTH a connection with a fixture key and return the updated ConnState. */
async function authed(
  core: RelayCore,
  conn: ConnState,
  sk = ALICE_SK,
): Promise<ConnState> {
  const out = await send(core, conn, ["AUTH", signLoginEvent(conn.challenge, { sk })]);
  expect(out.updatedConn).toBeDefined();
  return out.updatedConn as ConnState;
}

/** Seed a D1 rate_limits counter at the current window. */
async function seedLimit(
  key: string,
  count: number,
  windowSeconds: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)",
  )
    .bind(key, count, now - (now % windowSeconds))
    .run();
}

const NOW = () => Math.floor(Date.now() / 1000);

function post(over: Partial<Parameters<typeof signPostEvent>[0]> = {}): NostrEvent {
  return signPostEvent({
    d: "hello",
    title: "Hello",
    content: "hello world",
    created_at: NOW(),
    ...over,
  });
}

beforeEach(async () => {
  await resetMirrorState();
  await resetRateLimits();
  await resetUsers();
  await seedAlice();
});

// --- AUTH flow --------------------------------------------------------------------

describe("RelayCore — NIP-42 AUTH flow", () => {
  it("flips authedPubkey and answers OK true on a valid AUTH", async () => {
    const { core } = makeCore();
    const conn = makeConn();
    const ev = signLoginEvent(conn.challenge);
    const out = await send(core, conn, ["AUTH", ev]);
    expect(out.frames.map(parse)).toEqual([["OK", ev.id, true, ""]]);
    expect(out.updatedConn).toMatchObject({
      authedPubkey: ALICE_PK,
      allowedUntil: 0,
      challenge: conn.challenge,
    });
    expect(out.close).toBeUndefined();
  });

  it("rejects a wrong-challenge AUTH with OK false and no state change", async () => {
    const { core } = makeCore();
    const conn = makeConn();
    const ev = signLoginEvent("cd".repeat(32));
    const out = await send(core, conn, ["AUTH", ev]);
    const frame = parse(out.frames[0] as string);
    expect(frame[0]).toBe("OK");
    expect(frame[1]).toBe(ev.id);
    expect(frame[2]).toBe(false);
    expect(frame[3]).toMatch(/^invalid: /);
    expect(out.updatedConn).toBeUndefined();
  });

  it("closes 1008 after MAX_AUTH_ATTEMPTS failed attempts", async () => {
    const { core } = makeCore();
    const conn = makeConn();
    const bad = signLoginEvent("cd".repeat(32));
    for (let i = 0; i < MAX_AUTH_ATTEMPTS; i++) {
      const out = await send(core, conn, ["AUTH", bad]);
      expect(out.close).toBeUndefined();
    }
    const out = await send(core, conn, ["AUTH", signLoginEvent(conn.challenge)]);
    expect(out.close).toEqual({ code: 1008, reason: "too many auth attempts" });
    // The over-limit attempt must not have authenticated the connection.
    expect(out.updatedConn).toBeUndefined();
  });

  it("re-auth under a different key resets the cached allowlist verdict", async () => {
    const { core } = makeCore();
    let conn = makeConn();
    conn = await authed(core, conn, ALICE_SK);
    // Simulate a warm allowlist cache, then re-auth as bob.
    conn = { ...conn, allowedUntil: NOW() + ALLOWLIST_CACHE_SECONDS };
    const out = await send(core, conn, ["AUTH", signLoginEvent(conn.challenge, { sk: BOB_SK })]);
    expect(out.updatedConn).toMatchObject({ authedPubkey: BOB_PK, allowedUntil: 0 });
  });
});

// --- EVENT rejection ladder ---------------------------------------------------------

describe("RelayCore — EVENT rejection ladder", () => {
  it("rejects disallowed kinds before anything else (even unauthenticated)", async () => {
    const { core } = makeCore();
    const conn = makeConn(); // unauthenticated on purpose
    const ev = signLoginEvent(conn.challenge); // kind 22242 — not in the allowlist
    const out = await send(core, conn, ["EVENT", ev]);
    expect(out.frames.map(parse)).toEqual([
      ["OK", ev.id, false, "restricted: only kinds 30023, 5, and 0 are accepted"],
    ]);
  });

  it("answers auth-required + a fresh AUTH frame when unauthenticated", async () => {
    const { core } = makeCore();
    const conn = makeConn();
    const ev = post();
    const out = await send(core, conn, ["EVENT", ev]);
    expect(out.frames.map(parse)).toEqual([
      ["OK", ev.id, false, "auth-required: authenticate with your nbread key first"],
      ["AUTH", conn.challenge],
    ]);
  });

  it("checks auth BEFORE the allowlist: an unclaimed key still gets auth-required", async () => {
    const { core } = makeCore();
    const conn = makeConn();
    const ev = post({ sk: BOB_SK }); // bob has no user row at all
    const out = await send(core, conn, ["EVENT", ev]);
    expect((parse(out.frames[0] as string) as unknown[])[3]).toMatch(/^auth-required: /);
  });

  it("rejects an event whose pubkey is not the authenticated key", async () => {
    const { core } = makeCore();
    const aliceConn = await authed(core, makeConn(), ALICE_SK);
    const ev = post({ sk: BOB_SK });
    const out = await send(core, aliceConn, ["EVENT", ev]);
    expect(out.frames.map(parse)).toEqual([
      ["OK", ev.id, false, "restricted: event pubkey does not match the authenticated key"],
    ]);
  });

  it("rejects an authed key with no claimed handle", async () => {
    const { core } = makeCore();
    const conn = await authed(core, makeConn(), BOB_SK); // no users row
    const ev = post({ sk: BOB_SK });
    const out = await send(core, conn, ["EVENT", ev]);
    expect(out.frames.map(parse)).toEqual([
      ["OK", ev.id, false, "restricted: writes are limited to claimed nbread.lol handles"],
    ]);
  });

  it("rejects a blocked user", async () => {
    await seedBlockedMallory();
    const { core } = makeCore();
    const conn = await authed(core, makeConn(), MALLORY_SK);
    const ev = post({ sk: MALLORY_SK });
    const out = await send(core, conn, ["EVENT", ev]);
    expect((parse(out.frames[0] as string) as unknown[])[3]).toMatch(/^restricted: writes/);
  });

  it("checks the allowlist BEFORE rate limits: exhausted window still reads restricted", async () => {
    await seedLimit(`relay:ev:pk:${BOB_PK}`, EVENT_PK_MAX, EVENT_PK_WINDOW_SECONDS);
    const { core } = makeCore();
    const conn = await authed(core, makeConn(), BOB_SK); // unclaimed
    const out = await send(core, conn, ["EVENT", post({ sk: BOB_SK })]);
    expect((parse(out.frames[0] as string) as unknown[])[3]).toMatch(/^restricted: writes/);
  });

  it("rate-limits per pubkey (30/5min) without storing the event", async () => {
    await seedLimit(`relay:ev:pk:${ALICE_PK}`, EVENT_PK_MAX, EVENT_PK_WINDOW_SECONDS);
    const { core } = makeCore();
    const conn = await authed(core, makeConn(), ALICE_SK);
    const ev = post();
    const out = await send(core, conn, ["EVENT", ev]);
    expect(out.frames.map(parse)).toEqual([["OK", ev.id, false, "rate-limited: slow down"]]);
    const row = await env.DB.prepare("SELECT 1 FROM events WHERE id = ?").bind(ev.id).first();
    expect(row).toBeNull();
  });

  it("rate-limits on the global daily store budget", async () => {
    await seedLimit("relay:global:store", GLOBAL_STORE_MAX, GLOBAL_STORE_WINDOW_SECONDS);
    const { core } = makeCore();
    const conn = await authed(core, makeConn(), ALICE_SK);
    const out = await send(core, conn, ["EVENT", post()]);
    expect((parse(out.frames[0] as string) as unknown[])[3]).toBe("rate-limited: slow down");
  });

  it("accepts, stores, and caches the allowlist verdict on success", async () => {
    const { core } = makeCore();
    const conn = await authed(core, makeConn(), ALICE_SK);
    const ev = post();
    const before = NOW();
    const out = await send(core, conn, ["EVENT", ev]);
    expect(out.frames.map(parse)).toEqual([["OK", ev.id, true, ""]]);
    expect(out.updatedConn?.allowedUntil).toBeGreaterThanOrEqual(
      before + ALLOWLIST_CACHE_SECONDS,
    );
    const row = await env.DB.prepare("SELECT raw FROM events WHERE id = ?")
      .bind(ev.id)
      .first<{ raw: string }>();
    expect(row).not.toBeNull();
  });

  it("honors the 5-minute allowlist cache (no D1 re-check while warm)", async () => {
    const { core } = makeCore();
    let conn = await authed(core, makeConn(), ALICE_SK);
    conn = { ...conn, allowedUntil: NOW() + ALLOWLIST_CACHE_SECONDS };
    await resetUsers(); // alice's claim disappears — the warm cache must carry
    const ev = post();
    const out = await send(core, conn, ["EVENT", ev]);
    expect(out.frames.map(parse)).toEqual([["OK", ev.id, true, ""]]);
  });

  it("re-checks once the cache expires", async () => {
    const { core } = makeCore();
    let conn = await authed(core, makeConn(), ALICE_SK);
    conn = { ...conn, allowedUntil: 0 };
    await resetUsers();
    const out = await send(core, conn, ["EVENT", post()]);
    expect((parse(out.frames[0] as string) as unknown[])[3]).toMatch(/^restricted: writes/);
  });

  it("answers duplicate for a stale replaceable version", async () => {
    const { core } = makeCore();
    const conn = await authed(core, makeConn(), ALICE_SK);
    const t = NOW();
    const newer = post({ created_at: t });
    const older = post({ created_at: t - 100, content: "old body" });
    expect((parse((await send(core, conn, ["EVENT", newer])).frames[0] as string) as unknown[])[2]).toBe(true);
    const out = await send(core, conn, ["EVENT", older]);
    expect(out.frames.map(parse)).toEqual([
      ["OK", older.id, false, "duplicate: a newer version of this replaceable event is already stored"],
    ]);
  });

  it("answers invalid when id/signature verification fails", async () => {
    const { core } = makeCore();
    const conn = await authed(core, makeConn(), ALICE_SK);
    const forged = { ...post(), content: "tampered after signing" };
    const out = await send(core, conn, ["EVENT", forged]);
    expect(out.frames.map(parse)).toEqual([
      ["OK", forged.id, false, "invalid: id or signature verification failed"],
    ]);
  });
});

// --- REQ / CLOSE bookkeeping ---------------------------------------------------------

describe("RelayCore — REQ / CLOSE subscription bookkeeping", () => {
  it("CLOSEDs a malformed filter and stores nothing", async () => {
    const { core, store } = makeCore();
    const conn = makeConn();
    const out = await send(core, conn, ["REQ", "s1", { ids: [] }]);
    const frame = parse(out.frames[0] as string);
    expect(frame[0]).toBe("CLOSED");
    expect(frame[1]).toBe("s1");
    expect(frame[2]).toMatch(/^invalid: /);
    expect(store.count(conn.connId)).toBe(0);
  });

  it("EOSEs an empty result and persists the SANITIZED filters", async () => {
    const { core, store } = makeCore();
    const conn = makeConn();
    const out = await send(core, conn, ["REQ", "s1", { kinds: [30023], junk: "ignored" }]);
    expect(out.frames.map(parse)).toEqual([["EOSE", "s1"]]);
    const stored = JSON.parse(store.get(conn.connId, "s1") as string) as unknown[];
    expect(stored).toEqual([{ kinds: [30023], limit: 100 }]);
  });

  it("serves stored events newest-first with the verbatim stored raw, then EOSE", async () => {
    const t = NOW();
    const ev1 = post({ d: "a", created_at: t - 10 });
    const ev2 = post({ d: "b", created_at: t });
    await mirrorEvent(env, ev1);
    await mirrorEvent(env, ev2);
    const { core } = makeCore();
    const conn = makeConn();
    const out = await send(core, conn, ["REQ", "s1", { kinds: [30023] }]);
    const frames = out.frames.map(parse);
    expect(frames).toHaveLength(3);
    expect(frames[0]?.slice(0, 2)).toEqual(["EVENT", "s1"]);
    expect((frames[0]?.[2] as NostrEvent).id).toBe(ev2.id);
    expect((frames[1]?.[2] as NostrEvent).id).toBe(ev1.id);
    expect(frames[2]).toEqual(["EOSE", "s1"]);
    // Verbatim raw: the frame embeds exactly the D1-stored JSON text.
    const row = await env.DB.prepare("SELECT raw FROM events WHERE id = ?")
      .bind(ev2.id)
      .first<{ raw: string }>();
    expect(out.frames[0]).toBe(`["EVENT","s1",${row?.raw}]`);
  });

  it("REPLACES a subscription reusing the same subId (NIP-01)", async () => {
    const { core, store } = makeCore();
    const conn = makeConn();
    await send(core, conn, ["REQ", "s1", { kinds: [30023] }]);
    await send(core, conn, ["REQ", "s1", { kinds: [0] }]);
    expect(store.count(conn.connId)).toBe(1);
    const stored = JSON.parse(store.get(conn.connId, "s1") as string) as unknown[];
    expect(stored).toEqual([{ kinds: [0], limit: 100 }]);
  });

  it("caps open subscriptions at 8 per connection", async () => {
    const { core, store } = makeCore();
    const conn = makeConn();
    for (let i = 0; i < 8; i++) {
      const out = await send(core, conn, ["REQ", `s${i}`, { kinds: [30023] }]);
      expect(parse(out.frames.at(-1) as string)[0]).toBe("EOSE");
    }
    const out = await send(core, conn, ["REQ", "s8", { kinds: [30023] }]);
    expect(out.frames.map(parse)).toEqual([
      ["CLOSED", "s8", "restricted: too many subscriptions"],
    ]);
    expect(store.count(conn.connId)).toBe(8);
    // …but an existing subId can still be replaced at the cap.
    const replace = await send(core, conn, ["REQ", "s0", { kinds: [5] }]);
    expect(parse(replace.frames.at(-1) as string)[0]).toBe("EOSE");
  });

  it("CLOSE deletes the subscription silently; unknown subIds are a no-op", async () => {
    const { core, store } = makeCore();
    const conn = makeConn();
    await send(core, conn, ["REQ", "s1", { kinds: [30023] }]);
    const out = await send(core, conn, ["CLOSE", "s1"]);
    expect(out.frames).toEqual([]);
    expect(store.count(conn.connId)).toBe(0);
    const noop = await send(core, conn, ["CLOSE", "never-existed"]);
    expect(noop.frames).toEqual([]);
  });

  it("dropConn wipes a connection's subscriptions", async () => {
    const { core, store } = makeCore();
    const conn = makeConn();
    await send(core, conn, ["REQ", "s1", { kinds: [30023] }]);
    core.dropConn(conn.connId);
    expect(store.count(conn.connId)).toBe(0);
  });
});

// --- Live fan-out ---------------------------------------------------------------------

describe("RelayCore — live fan-out on stored EVENTs", () => {
  it("fans out to matching subs (sender included), skips non-matching", async () => {
    const { core } = makeCore();
    const alice = await authed(core, makeConn(), ALICE_SK);
    const reader = makeConn();
    const other = makeConn();
    await send(core, reader, ["REQ", "watch", { kinds: [30023], authors: [ALICE_PK] }]);
    await send(core, other, ["REQ", "misses", { kinds: [30023], authors: [BOB_PK] }]);
    await send(core, alice, ["REQ", "own", { kinds: [30023] }]);

    const ev = post();
    const out = await send(core, alice, ["EVENT", ev]);
    expect((parse(out.frames[0] as string) as unknown[])[2]).toBe(true);

    const targets = out.fanout.map((f) => {
      const frame = parse(f.frame);
      return { connId: f.connId, subId: frame[1], id: (frame[2] as NostrEvent).id };
    });
    expect(targets).toEqual(
      expect.arrayContaining([
        { connId: reader.connId, subId: "watch", id: ev.id },
        { connId: alice.connId, subId: "own", id: ev.id },
      ]),
    );
    expect(targets).toHaveLength(2);
  });

  it("matches generic tag filters (#t) on fan-out", async () => {
    const { core } = makeCore();
    const alice = await authed(core, makeConn(), ALICE_SK);
    const reader = makeConn();
    await send(core, reader, ["REQ", "tags", { "#t": ["nostr"] }]);
    await send(core, reader, ["REQ", "othertag", { "#t": ["bitcoin"] }]);

    const ev = signPostEvent({ d: "t", title: "T", content: "x", created_at: NOW() });
    ev.tags.push(["t", "nostr"]);
    // re-sign with the mutated tags
    const { finalizeEvent } = await import("nostr-tools/pure");
    const { hexToBytes } = await import("@noble/hashes/utils.js");
    const signed = finalizeEvent(
      { kind: 30023, created_at: ev.created_at, tags: ev.tags, content: ev.content },
      hexToBytes(ALICE_SK),
    ) as NostrEvent;

    const out = await send(core, alice, ["EVENT", signed]);
    expect(out.fanout.map((f) => parse(f.frame)[1])).toEqual(["tags"]);
  });

  it("fans out kind-5 deletes too", async () => {
    const { core } = makeCore();
    const alice = await authed(core, makeConn(), ALICE_SK);
    const reader = makeConn();
    await send(core, reader, ["REQ", "dels", { kinds: [5] }]);
    const del = signDeleteEvent({ address: `30023:${ALICE_PK}:gone`, created_at: NOW() });
    const out = await send(core, alice, ["EVENT", del]);
    expect((parse(out.frames[0] as string) as unknown[])[2]).toBe(true);
    expect(out.fanout.map((f) => parse(f.frame)[1])).toEqual(["dels"]);
  });

  it("does NOT fan out rejected events", async () => {
    const { core } = makeCore();
    const reader = makeConn();
    await send(core, reader, ["REQ", "watch", { kinds: [30023] }]);
    const unauthedConn = makeConn();
    const out = await send(core, unauthedConn, ["EVENT", post()]);
    expect(out.fanout).toEqual([]);
  });
});

// --- Frame hygiene + message rate --------------------------------------------------------

describe("RelayCore — frame hygiene and message rate", () => {
  it("NOTICEs junk frames", async () => {
    const { core } = makeCore();
    const out = await core.handleMessage(makeConn(), "not json at all");
    const frame = parse(out.frames[0] as string);
    expect(frame[0]).toBe("NOTICE");
    expect(out.close).toBeUndefined();
  });

  it("NOTICEs oversized frames without parsing them", async () => {
    const { core } = makeCore();
    const out = await core.handleMessage(makeConn(), "x".repeat(1_048_577));
    const frame = parse(out.frames[0] as string);
    expect(frame[0]).toBe("NOTICE");
    expect(frame[1]).toMatch(/too large/);
  });

  it("answers OK false (not NOTICE) for a broken EVENT with a plausible id", async () => {
    const { core } = makeCore();
    const id = "cd".repeat(32);
    const out = await send(core, makeConn(), ["EVENT", { id, kind: "nope" }]);
    const frame = parse(out.frames[0] as string);
    expect(frame[0]).toBe("OK");
    expect(frame[1]).toBe(id);
    expect(frame[2]).toBe(false);
  });

  it("closes 1008 when a connection exceeds 120 messages/minute", async () => {
    let t = 1_700_000_000;
    const { core } = makeCore(new MemStore(), () => t);
    const conn = makeConn();
    for (let i = 0; i < MAX_MESSAGES_PER_MINUTE; i++) {
      const out = await send(core, conn, ["CLOSE", "s1"]);
      expect(out.close).toBeUndefined();
    }
    const out = await send(core, conn, ["CLOSE", "s1"]);
    expect(parse(out.frames[0] as string)).toEqual([
      "NOTICE",
      "rate-limited: too many messages",
    ]);
    expect(out.close).toEqual({ code: 1008, reason: "message rate exceeded" });
    // A fresh window admits the connection again.
    t += 60;
    const later = await send(core, conn, ["CLOSE", "s1"]);
    expect(later.close).toBeUndefined();
  });

  it("message-rate windows are per connection", async () => {
    let t = 1_700_000_000;
    const { core } = makeCore(new MemStore(), () => t);
    const a = makeConn();
    const b = makeConn();
    for (let i = 0; i < MAX_MESSAGES_PER_MINUTE; i++) {
      await send(core, a, ["CLOSE", "s1"]);
    }
    expect((await send(core, a, ["CLOSE", "s1"])).close).toBeDefined();
    expect((await send(core, b, ["CLOSE", "s1"])).close).toBeUndefined();
  });
});
