// Cron ingestion hardening (P3 review fixes), proven via SELF.scheduled()
// against the mock relay:
//   - a forged flood (valid ids, garbage sigs) can neither be mirrored nor
//     advance the sync watermark — a single hostile relay must not be able
//     to strand a claimed user's future events behind a poisoned `since`;
//   - a VALID far-future event (client clock skew) is skipped and never
//     advances the watermark;
//   - a backlog larger than the 60-event relay page is recovered via
//     `until`-paging — NIP-01 `limit` keeps the newest events, so without
//     paging the oldest posts would be silently lost forever.
import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import { serveEvents, resetMockRelay } from "../mock-relay";
import { seedAlice, resetMirrorState, ALICE_PK } from "../helpers";
import { readSince } from "../../src/cron/refresh";
import { getEventId, type NostrEvent } from "../../src/nostr/event";

const aliceHello = fixtures.posts.aliceHello as NostrEvent;
const aliceFuture = fixtures.extras.aliceFuture as NostrEvent;
const floodAlice = fixtures.extras.floodAlice as NostrEvent[];

const runScheduled = async () => {
  type ScheduledFetcher = typeof SELF & {
    scheduled(opts?: { scheduledTime?: Date; cron?: string }): Promise<{
      outcome: string;
    }>;
  };
  const result = await (SELF as ScheduledFetcher).scheduled({
    cron: "*/15 * * * *",
  });
  expect(result.outcome).toBe("ok");
};

async function eventCount(pubkey: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE pubkey = ?",
  )
    .bind(pubkey)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function aliceSince(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT settings FROM users WHERE pubkey = ?",
  )
    .bind(ALICE_PK)
    .first<{ settings: string }>();
  return readSince(row?.settings ?? "{}");
}

// Storage persists across tests in this file — start each test clean.
beforeEach(async () => {
  await seedAlice();
  await resetMirrorState();
  await env.DB.prepare("UPDATE users SET settings = '{}' WHERE pubkey = ?")
    .bind(ALICE_PK)
    .run();
});

afterEach(() => {
  resetMockRelay();
});

describe("cron refresh — watermark hardening", () => {
  it("a forged flood neither mirrors nor advances the watermark", async () => {
    // 65 structurally-valid FORGED events: correct sha256 ids (they pass the
    // relay-side id recompute) but garbage sigs (schnorr verification fails
    // at mirror time). 65 > the 60-event page, so this also exercises the
    // full-page path under hostile input.
    const forged: NostrEvent[] = [];
    for (let i = 0; i < 65; i++) {
      const tpl = {
        pubkey: ALICE_PK,
        kind: 30023,
        created_at: 1700100000 + i,
        tags: [["d", `forged-${String(i).padStart(2, "0")}`]],
        content: `forged ${i}`,
      };
      forged.push({ ...tpl, id: getEventId(tpl), sig: "ab".repeat(64) });
    }
    serveEvents(forged);

    await runScheduled();
    expect(await eventCount(ALICE_PK)).toBe(0); // nothing stored
    expect(await aliceSince()).toBe(0); // watermark untouched
  });

  it("a valid far-future event is skipped and never advances the watermark", async () => {
    serveEvents([aliceHello, aliceFuture]);

    await runScheduled();
    // The honest post mirrors; the year-2100 event does not:
    expect(await eventCount(ALICE_PK)).toBe(1);
    expect(await aliceSince()).toBe(aliceHello.created_at);

    // Stable on the next tick (the future event is refetched and re-skipped
    // without burning verification credits):
    await runScheduled();
    expect(await eventCount(ALICE_PK)).toBe(1);
    expect(await aliceSince()).toBe(aliceHello.created_at);
  });

  it("recovers a backlog beyond the relay page limit via until-paging", async () => {
    expect(floodAlice.length).toBe(65); // > REFRESH_FETCH_LIMIT (60)
    serveEvents(floodAlice);

    // 65 events at 5 verifications per run = 13 runs to full recovery. The
    // pre-fix code would have pinned the watermark past the oldest 5 events
    // on run 1 (the relay's newest-60 page dropped them) and lost them.
    for (let run = 0; run < 13; run++) await runScheduled();

    expect(await eventCount(ALICE_PK)).toBe(65); // ALL posts, oldest included
    const maxCreated = Math.max(...floodAlice.map((ev) => ev.created_at));
    expect(await aliceSince()).toBe(maxCreated);
  });
});
