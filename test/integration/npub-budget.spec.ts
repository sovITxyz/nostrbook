// Abuse caps for the on-demand npub mirror (P3 review fixes): the per-pubkey
// cooldown is enumeration-bypassable (unlimited distinct valid npubs), so
// relay mirror sessions are additionally bounded by a GLOBAL daily budget
// and a PER-IP daily budget, both D1-backed (rate_limits). A denied visit
// still serves whatever is already in D1 and does NOT set the cooldown.
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import { serveEvents, resetMockRelay } from "../mock-relay";
import { ALICE_PK, BOB_PK } from "../helpers";
import { npubEncode } from "../../src/nostr/nip19";
import {
  npubCooldownKey,
  NPUB_MIRROR_GLOBAL_DAILY_CAP,
  NPUB_MIRROR_GLOBAL_KEY,
  NPUB_MIRROR_IP_DAILY_CAP,
} from "../../src/routes/main";
import { checkRateLimit } from "../../src/services/ratelimit";
import { defaultCache } from "../../src/middleware/cache";
import type { NostrEvent } from "../../src/nostr/event";

const bobNpub = npubEncode(BOB_PK);
const aliceNpub = npubEncode(ALICE_PK);

const bobEvents: NostrEvent[] = [
  fixtures.profiles.bob,
  fixtures.posts.bobFirst,
  ...fixtures.extras.bulkBob,
] as NostrEvent[];

const aliceEvents: NostrEvent[] = [
  fixtures.profiles.alice,
  fixtures.posts.aliceHello,
  fixtures.posts.aliceTorture,
] as NostrEvent[];

const DAY_SECONDS = 86_400;

function windowStart(): number {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % DAY_SECONDS);
}

/** Pin a rate_limits counter to an exact count in the CURRENT window. */
async function seedCounter(key: string, count: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = excluded.count, window_start = excluded.window_start`,
  )
    .bind(key, count, windowStart())
    .run();
}

async function eventCount(pubkey: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE pubkey = ?",
  )
    .bind(pubkey)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

afterEach(async () => {
  resetMockRelay();
  await defaultCache().delete(npubCooldownKey(BOB_PK));
  await defaultCache().delete(npubCooldownKey(ALICE_PK));
  await env.DB.prepare("DELETE FROM rate_limits").run();
});

describe("checkRateLimit (D1 fixed window)", () => {
  it("allows up to the cap in a window, then denies", async () => {
    for (let i = 1; i <= 3; i++) {
      const r = await checkRateLimit(env, "test:key", 3, 60);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(3 - i);
    }
    const denied = await checkRateLimit(env, "test:key", 3, 60);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });
});

describe("npub on-demand mirror budget", () => {
  it("per-IP daily cap: one IP cannot drain the mirror budget", async () => {
    serveEvents(bobEvents);
    await seedCounter("npub-mirror:ip:9.9.9.9", NPUB_MIRROR_IP_DAILY_CAP);

    // The capped IP gets a page but NO relay mirror session runs:
    const r1 = await SELF.fetch(`https://nbread.lol/${bobNpub}`, {
      headers: { "CF-Connecting-IP": "9.9.9.9" },
    });
    expect(r1.status).toBe(200);
    expect(await eventCount(BOB_PK)).toBe(0);

    // A different IP still has budget (the denial did NOT set the cooldown):
    const r2 = await SELF.fetch(`https://nbread.lol/${bobNpub}`, {
      headers: { "CF-Connecting-IP": "8.8.8.8" },
    });
    expect(r2.status).toBe(200);
    expect(await eventCount(BOB_PK)).toBe(10); // NPUB_MIRROR_CAP
  });

  it("global daily cap: relay mirroring stops platform-wide once exhausted", async () => {
    serveEvents(aliceEvents);
    await seedCounter(NPUB_MIRROR_GLOBAL_KEY, NPUB_MIRROR_GLOBAL_DAILY_CAP);

    const r1 = await SELF.fetch(`https://nbread.lol/${aliceNpub}`);
    expect(r1.status).toBe(200); // serves what D1 has (nothing) without relay work
    expect(await eventCount(ALICE_PK)).toBe(0);

    // Budget frees up (next day) → the same npub mirrors normally, because
    // the denied attempt never marked the cooldown:
    await env.DB.prepare("DELETE FROM rate_limits").run();
    const r2 = await SELF.fetch(`https://nbread.lol/${aliceNpub}`);
    expect(r2.status).toBe(200);
    expect(await eventCount(ALICE_PK)).toBe(aliceEvents.length);
  });
});
