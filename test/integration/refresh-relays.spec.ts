// P5 review fix: cron sync must fetch from the USER'S configured relays
// (users.settings.$.relays) merged with the global RELAYS defaults. Before
// the fix, runRefresh only ever dialed the RELAYS env list, so a user whose
// posts lived solely on their configured relays (the reason to configure
// them) was never mirrored by cron — the setting promised "editor-side
// broadcast + sync" but only the client-side broadcast used it.
import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import { serveEventsByUrl, resetMockRelay } from "../mock-relay";
import {
  ALICE_PK,
  resetMirrorState,
  resetUsers,
  seedAlice,
} from "../helpers";
import type { NostrEvent } from "../../src/nostr/event";

const aliceHello = fixtures.posts.aliceHello as NostrEvent;

const USER_RELAY = "wss://user-relay.example/";

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

beforeEach(async () => {
  await resetMirrorState();
  await resetUsers();
  await seedAlice();
});

afterEach(() => {
  resetMockRelay();
});

describe("cron refresh — user-configured relays participate in sync", () => {
  it("mirrors a post that exists ONLY on the user's configured relay", async () => {
    // Alice's post lives exclusively on her configured relay; the global
    // RELAYS defaults serve nothing.
    await env.DB.prepare("UPDATE users SET settings = ? WHERE pubkey = ?")
      .bind(JSON.stringify({ relays: [USER_RELAY] }), ALICE_PK)
      .run();
    const dialed: string[] = [];
    serveEventsByUrl({ [USER_RELAY]: [aliceHello] }, dialed);

    await runScheduled();

    // The configured relay was dialed AND the defaults were still included
    // (merge, not replace — the setting must never silently drop coverage).
    expect(dialed).toContain(USER_RELAY);
    for (const def of env.RELAYS.split(",")) {
      expect(dialed).toContain(def.trim());
    }

    // The post that only the user's relay carried is now mirrored.
    const row = await env.DB.prepare(
      "SELECT id FROM events WHERE pubkey = ? AND d_tag = 'hello-world'",
    )
      .bind(ALICE_PK)
      .first<{ id: string }>();
    expect(row?.id).toBe(aliceHello.id);
  });

  it("never dials the first-party nbread relay, even when configured", async () => {
    // Users may paste wss://nbread.lol/relay into their settings. Cron must
    // filter it out: a Worker-to-own-zone ws subrequest won't reliably
    // re-enter the Worker, and the relay shares the same D1 store anyway.
    const SELF_RELAY = "wss://nbread.lol/relay";
    await env.DB.prepare("UPDATE users SET settings = ? WHERE pubkey = ?")
      .bind(JSON.stringify({ relays: [SELF_RELAY, USER_RELAY] }), ALICE_PK)
      .run();
    const dialed: string[] = [];
    serveEventsByUrl({ [USER_RELAY]: [aliceHello] }, dialed);

    await runScheduled();

    expect(dialed).not.toContain(SELF_RELAY);
    expect(dialed).toContain(USER_RELAY); // other configured relays survive
    const row = await env.DB.prepare(
      "SELECT id FROM events WHERE pubkey = ? AND d_tag = 'hello-world'",
    )
      .bind(ALICE_PK)
      .first<{ id: string }>();
    expect(row?.id).toBe(aliceHello.id);
  });

  it("still syncs from the defaults when the user configured nothing", async () => {
    const dialed: string[] = [];
    serveEventsByUrl(
      { "wss://relay.damus.io": [aliceHello] }, // first default relay
      dialed,
    );

    await runScheduled();

    expect(dialed).toContain("wss://relay.damus.io");
    const row = await env.DB.prepare(
      "SELECT id FROM events WHERE pubkey = ? AND d_tag = 'hello-world'",
    )
      .bind(ALICE_PK)
      .first<{ id: string }>();
    expect(row?.id).toBe(aliceHello.id);
  });
});
