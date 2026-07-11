// Cron ingestion via SELF.scheduled() against the mock relay: claimed users
// get their kinds 0+30023 mirrored with the per-run verification cap, the
// since-watermark resumes the backlog next tick, and blocked/unclaimed
// pubkeys are never fetched.
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import { serveEvents, resetMockRelay } from "../mock-relay";
import { seedAlice, seedBlockedMallory, ALICE_PK, BOB_PK, MALLORY_PK } from "../helpers";
import { REFRESH_VERIFY_CAP, readSince } from "../../src/cron/refresh";
import type { NostrEvent } from "../../src/nostr/event";

// Alice's full relay backlog: 1 profile + 6 posts (incl. the replaceable
// stale/newer pair) = 7 events → run 1 mirrors 5 (cap), run 2 the rest.
const aliceBacklog: NostrEvent[] = [
  fixtures.profiles.alice,
  fixtures.posts.aliceHello,
  fixtures.posts.aliceTorture,
  fixtures.posts.aliceXss,
  fixtures.posts.aliceEscapes,
  fixtures.replaceable.stale,
  fixtures.replaceable.newer,
] as NostrEvent[];

// Noise the relay also carries — never fetched for unclaimed/blocked users.
const noise: NostrEvent[] = [
  fixtures.profiles.bob,
  fixtures.posts.bobFirst,
  fixtures.profiles.mallory,
] as NostrEvent[];

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

async function aliceSettings(): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT settings FROM users WHERE pubkey = ?",
  )
    .bind(ALICE_PK)
    .first<{ settings: string }>();
  return row?.settings ?? "{}";
}

afterEach(() => {
  resetMockRelay();
});

describe("SELF.scheduled() — cron refresh", () => {
  it("mirrors with the per-run verification cap and resumes next tick", async () => {
    expect(REFRESH_VERIFY_CAP).toBe(5);
    await seedAlice();
    serveEvents([...aliceBacklog, ...noise]);

    // Run 1: oldest 5 of the 7-event backlog (profile + 4 posts).
    await runScheduled();
    expect(await eventCount(ALICE_PK)).toBe(5);
    // Profile landed in the profiles table too:
    const profile = await env.DB.prepare(
      "SELECT name FROM profiles WHERE pubkey = ?",
    )
      .bind(ALICE_PK)
      .first<{ name: string }>();
    expect(profile?.name).toBe("alice-test");
    // Watermark = created_at of the last processed event (aliceEscapes).
    expect(readSince(await aliceSettings())).toBe(1700000450);
    // The replaceable pair is still unprocessed:
    const slot1 = await env.DB.prepare(
      "SELECT id FROM events WHERE pubkey = ? AND d_tag = 'replaceable'",
    )
      .bind(ALICE_PK)
      .all<{ id: string }>();
    expect(slot1.results.length).toBe(0);

    // Run 2: the remaining stale+newer pair — stale is stored first
    // (ascending order), then the newer version replaces it: net ONE row.
    await runScheduled();
    expect(await eventCount(ALICE_PK)).toBe(6);
    const slot2 = await env.DB.prepare(
      "SELECT id, content FROM events WHERE pubkey = ? AND d_tag = 'replaceable'",
    )
      .bind(ALICE_PK)
      .all<{ id: string; content: string }>();
    expect(slot2.results.length).toBe(1);
    expect(slot2.results[0]!.id).toBe(fixtures.replaceable.newer.id);
    expect(slot2.results[0]!.content).toContain("Version 2");
    expect(readSince(await aliceSettings())).toBe(1700000600);

    // Run 3: nothing new — counts and watermark stay put.
    await runScheduled();
    expect(await eventCount(ALICE_PK)).toBe(6);
    expect(readSince(await aliceSettings())).toBe(1700000600);
  });

  it("never fetches for blocked or unclaimed pubkeys", async () => {
    await seedBlockedMallory(); // mallory: claimed but blocked
    serveEvents(noise); // relay has mallory's profile and bob's events
    await runScheduled();
    expect(await eventCount(MALLORY_PK)).toBe(0);
    expect(await eventCount(BOB_PK)).toBe(0); // bob is unclaimed
  });
});
