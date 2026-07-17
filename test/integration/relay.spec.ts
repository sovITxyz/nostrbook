// PR2 packet 5: the first-party relay end-to-end over a REAL WebSocket.
//
// Every case drives the live upgrade path: SELF.fetch("https://nbread.lol/
// relay", { Upgrade: "websocket" }) returns a 101 whose client socket the
// TEST accepts (resp.webSocket.accept()) and exchanges frames with. Accepting
// on the TEST side — not inside a nested request/scheduled context — is what
// dodges workerd's cross-context WebSocketPair hang-detection (see
// test/mock-relay.ts). Frames are awaited one at a time through a small
// promise queue so ordering assertions are deterministic.
//
// The Worker (src/relay/http.ts) answers NIP-11 and the plain info page
// itself; the DO (src/relay/do.ts) serves only ws traffic. Storage is the
// shared D1 `events` table via mirrorEvent, so a published post is asserted
// BOTH back through the relay (REQ → EVENT/EOSE) and through the normal blog
// path (https://alice.nbread.lol/<slug>) — relay and blog can never disagree.
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  ALICE_PK,
  ALICE_SK,
  BOB_PK,
  BOB_SK,
  resetMirrorState,
  resetRateLimits,
  resetUsers,
  seedAlice,
  signDeleteEvent,
  signLoginEvent,
  signPostEvent,
} from "../helpers";
import type { NostrEvent } from "../../src/nostr/event";
import { nip11Document } from "../../src/relay/nip11";

// --- WebSocket harness ----------------------------------------------------------

type Frame = unknown[];

/**
 * A test-side wrapper around an accepted client socket: buffers inbound text
 * frames and hands them out one at a time via next() (awaited promise if none
 * are queued yet). send() serializes a NIP-01 tuple.
 */
type Harness = {
  raw: WebSocket;
  send: (msg: unknown[]) => void;
  next: () => Promise<Frame>;
  close: () => void;
};

function harness(ws: WebSocket): Harness {
  const queue: string[] = [];
  const waiters: ((v: string) => void)[] = [];
  ws.addEventListener("message", (e: MessageEvent) => {
    const data = typeof e.data === "string" ? e.data : "";
    const w = waiters.shift();
    if (w !== undefined) w(data);
    else queue.push(data);
  });
  return {
    raw: ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: () =>
      new Promise<Frame>((resolve) => {
        const deliver = (s: string) => resolve(JSON.parse(s) as Frame);
        const q = queue.shift();
        if (q !== undefined) deliver(q);
        else waiters.push(deliver);
      }),
    close: () => {
      try {
        ws.close();
      } catch {
        // already closing/closed
      }
    },
  };
}

let ipCounter = 0;

/**
 * Open a ws connection to the relay and consume the immediate NIP-42 AUTH
 * challenge frame, returning the harness plus that challenge string. Each call
 * uses a fresh CF-Connecting-IP so the per-IP upgrade window never trips
 * across the many connections a single test opens.
 */
async function connect(): Promise<{ ws: Harness; challenge: string }> {
  ipCounter += 1;
  const resp = await SELF.fetch("https://nbread.lol/relay", {
    headers: {
      Upgrade: "websocket",
      "CF-Connecting-IP": `203.0.113.${ipCounter}`,
    },
  });
  expect(resp.status).toBe(101);
  const ws = resp.webSocket;
  expect(ws).not.toBeNull();
  ws!.accept();
  const h = harness(ws!);
  const first = await h.next();
  expect(first[0]).toBe("AUTH");
  return { ws: h, challenge: first[1] as string };
}

/** AUTH a connection with a fixture key; asserts OK true and returns nothing. */
async function authenticate(
  ws: Harness,
  challenge: string,
  sk: string,
): Promise<void> {
  ws.send(["AUTH", signLoginEvent(challenge, { sk })]);
  const ok = await ws.next();
  expect(ok[0]).toBe("OK");
  expect(ok[2]).toBe(true);
}

/** Sign an arbitrary-kind event with a fixture key (for the disallowed kinds). */
function signEvent(
  sk: string,
  opts: { kind: number; created_at?: number; tags?: string[][]; content?: string },
): NostrEvent {
  return finalizeEvent(
    {
      kind: opts.kind,
      created_at: opts.created_at ?? Math.floor(Date.now() / 1000),
      tags: opts.tags ?? [],
      content: opts.content ?? "",
    },
    hexToBytes(sk),
  ) as NostrEvent;
}

const NOW = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  await resetMirrorState();
  await resetRateLimits();
  await resetUsers();
  await seedAlice();
});

// --- NIP-11 + info page (Worker-served, no DO cost) --------------------------------

describe("relay HTTP surface (NIP-11 + info page)", () => {
  it("serves the NIP-11 document matching nip11Document(env) with CORS", async () => {
    const resp = await SELF.fetch("https://nbread.lol/relay", {
      headers: { Accept: "application/nostr+json" },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/nostr+json");
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(resp.headers.get("Cache-Control")).toContain("max-age=3600");
    const doc = await resp.json();
    expect(doc).toEqual(nip11Document(env));
    // sanity on the load-bearing advertised facts
    expect((doc as { supported_nips: number[] }).supported_nips).toContain(42);
    expect((doc as { limitation: { restricted_writes: boolean } }).limitation.restricted_writes).toBe(true);
  });

  it("serves a plain-text info page on a bare GET (no upgrade, no Accept)", async () => {
    const resp = await SELF.fetch("https://nbread.lol/relay");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("text/plain");
    const body = await resp.text();
    expect(body).toContain("wss://nbread.lol/relay");
    expect(body).toContain("Reads are open");
  });

  it("404s the relay path on a non-apex host", async () => {
    const resp = await SELF.fetch("https://alice.nbread.lol/relay");
    expect(resp.status).toBe(404);
  });
});

// --- AUTH + write path -------------------------------------------------------------

describe("relay ws — AUTH and the EVENT write path", () => {
  it("sends a NIP-42 AUTH challenge immediately on connect", async () => {
    const { ws, challenge } = await connect();
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);
    ws.close();
  });

  it("rejects an unauthenticated EVENT with auth-required + a fresh challenge", async () => {
    const { ws } = await connect();
    const ev = signPostEvent({ d: "no-auth", title: "T", content: "x", created_at: NOW() });
    ws.send(["EVENT", ev]);
    const ok = await ws.next();
    expect(ok).toEqual(["OK", ev.id, false, "auth-required: authenticate with your nbread key first"]);
    const reauth = await ws.next();
    expect(reauth[0]).toBe("AUTH");
    ws.close();
  });

  it("accepts a claimed key's 30023 — readable via REQ AND through the blog path", async () => {
    const { ws, challenge } = await connect();
    await authenticate(ws, challenge, ALICE_SK);

    const post = signPostEvent({
      d: "relay-post",
      title: "Published via the relay",
      content: "hello from the first-party relay",
      created_at: NOW(),
    });
    ws.send(["EVENT", post]);
    const ok = await ws.next();
    expect(ok).toEqual(["OK", post.id, true, ""]);

    // Readable back through a REQ on the same connection: EVENT then EOSE.
    ws.send(["REQ", "read", { kinds: [30023], authors: [ALICE_PK] }]);
    const evFrame = await ws.next();
    expect(evFrame[0]).toBe("EVENT");
    expect(evFrame[1]).toBe("read");
    expect((evFrame[2] as NostrEvent).id).toBe(post.id);
    expect((evFrame[2] as NostrEvent).sig).toBe(post.sig);
    const eose = await ws.next();
    expect(eose).toEqual(["EOSE", "read"]);

    // Same event is live on the blog (shared D1 events table via mirrorEvent).
    const blog = await SELF.fetch("https://alice.nbread.lol/relay-post");
    expect(blog.status).toBe(200);
    const html = await blog.text();
    expect(html).toContain("hello from the first-party relay");
    ws.close();
  });

  it("restricts a claimed-but-mismatched pubkey and an UNclaimed key", async () => {
    // authed as alice, but the event is bob's key → pubkey mismatch
    const a = await connect();
    await authenticate(a.ws, a.challenge, ALICE_SK);
    const bobPost = signPostEvent({ sk: BOB_SK, d: "x", title: "X", content: "y", created_at: NOW() });
    a.ws.send(["EVENT", bobPost]);
    const mism = await a.ws.next();
    expect(mism[2]).toBe(false);
    expect(mism[3]).toMatch(/does not match the authenticated key/);
    a.ws.close();

    // authed as bob (a valid signer with NO claimed handle) → restricted write
    const b = await connect();
    await authenticate(b.ws, b.challenge, BOB_SK);
    const own = signPostEvent({ sk: BOB_SK, d: "z", title: "Z", content: "w", created_at: NOW() });
    b.ws.send(["EVENT", own]);
    const restricted = await b.ws.next();
    expect(restricted[2]).toBe(false);
    expect(restricted[3]).toMatch(/^restricted: writes are limited/);
    b.ws.close();
  });

  it("rejects a disallowed kind (kind 1) as restricted", async () => {
    const { ws, challenge } = await connect();
    await authenticate(ws, challenge, ALICE_SK);
    const note = signEvent(ALICE_SK, { kind: 1, content: "a short note" });
    ws.send(["EVENT", note]);
    const ok = await ws.next();
    expect(ok).toEqual([
      "OK",
      note.id,
      false,
      "restricted: only kinds 30023, 5, and 0 are accepted",
    ]);
    ws.close();
  });
});

// --- REQ engine + deletes ----------------------------------------------------------

describe("relay ws — REQ filtering and NIP-09 deletes", () => {
  it("honors filter correctness including the limit (newest first)", async () => {
    const { ws, challenge } = await connect();
    await authenticate(ws, challenge, ALICE_SK);

    const t = NOW();
    const p1 = signPostEvent({ d: "p1", title: "P1", content: "one", created_at: t - 30 });
    const p2 = signPostEvent({ d: "p2", title: "P2", content: "two", created_at: t - 20 });
    const p3 = signPostEvent({ d: "p3", title: "P3", content: "three", created_at: t - 10 });
    for (const ev of [p1, p2, p3]) {
      ws.send(["EVENT", ev]);
      expect((await ws.next())[2]).toBe(true);
    }

    // limit 2 → the two newest, p3 then p2, then EOSE
    ws.send(["REQ", "lim", { kinds: [30023], authors: [ALICE_PK], limit: 2 }]);
    const f1 = await ws.next();
    const f2 = await ws.next();
    const f3 = await ws.next();
    expect((f1[2] as NostrEvent).id).toBe(p3.id);
    expect((f2[2] as NostrEvent).id).toBe(p2.id);
    expect(f3).toEqual(["EOSE", "lim"]);
    ws.close();
  });

  it("stops serving a post once a kind-5 delete tombstones it", async () => {
    const { ws, challenge } = await connect();
    await authenticate(ws, challenge, ALICE_SK);

    const doomed = signPostEvent({ d: "doomed", title: "Doomed", content: "goodbye", created_at: NOW() });
    ws.send(["EVENT", doomed]);
    expect((await ws.next())[2]).toBe(true);

    // visible pre-delete
    ws.send(["REQ", "pre", { kinds: [30023], authors: [ALICE_PK] }]);
    expect((await ws.next())[0]).toBe("EVENT");
    expect(await ws.next()).toEqual(["EOSE", "pre"]);

    const del = signDeleteEvent({
      eventId: doomed.id,
      address: `30023:${ALICE_PK}:doomed`,
      created_at: NOW() + 1,
    });
    ws.send(["EVENT", del]);
    expect((await ws.next())[2]).toBe(true);

    // the post is gone from REQ; the delete marker itself is still servable
    ws.send(["REQ", "post", { kinds: [30023], authors: [ALICE_PK] }]);
    expect(await ws.next()).toEqual(["EOSE", "post"]);
    ws.send(["REQ", "dels", { kinds: [5], authors: [ALICE_PK] }]);
    const delFrame = await ws.next();
    expect(delFrame[0]).toBe("EVENT");
    expect((delFrame[2] as NostrEvent).id).toBe(del.id);
    expect(await ws.next()).toEqual(["EOSE", "dels"]);
    ws.close();
  });
});

// --- Live fan-out ------------------------------------------------------------------

describe("relay ws — live fan-out across connections", () => {
  it("delivers a freshly published EVENT to a second connection's matching REQ", async () => {
    const author = await connect();
    await authenticate(author.ws, author.challenge, ALICE_SK);

    // Reader subscribes and drains to EOSE (nothing stored yet).
    const reader = await connect();
    reader.ws.send(["REQ", "live", { kinds: [30023], authors: [ALICE_PK] }]);
    expect(await reader.ws.next()).toEqual(["EOSE", "live"]);

    // Author publishes; reader must receive the live EVENT frame.
    const post = signPostEvent({ d: "fanout", title: "Fanout", content: "broadcast body", created_at: NOW() });
    author.ws.send(["EVENT", post]);
    expect((await author.ws.next())[2]).toBe(true);

    const pushed = await reader.ws.next();
    expect(pushed[0]).toBe("EVENT");
    expect(pushed[1]).toBe("live");
    expect((pushed[2] as NostrEvent).id).toBe(post.id);

    author.ws.close();
    reader.ws.close();
  });
});
