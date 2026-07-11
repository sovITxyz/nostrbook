// nostrbook.net/npub1… — on-demand mirror for unclaimed pubkeys: newest-10
// cap per request, progressive backfill via ctx.waitUntil, claimed pubkeys
// redirect to their subdomain, malformed/blocked npubs 404.
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "../fixtures/events.json";
import { serveEvents, resetMockRelay } from "../mock-relay";
import { seedAlice, seedBlockedMallory, ALICE_PK, BOB_PK, MALLORY_PK } from "../helpers";
import { npubEncode } from "../../src/nostr/nip19";
import { npubCooldownKey, NPUB_MIRROR_CAP } from "../../src/routes/main";
import { defaultCache } from "../../src/middleware/cache";
import type { NostrEvent } from "../../src/nostr/event";

const bobNpub = npubEncode(BOB_PK);
const aliceNpub = npubEncode(ALICE_PK);
const malloryNpub = npubEncode(MALLORY_PK);

// Bob's relay backlog: profile (T0+1) + bobFirst (T0+400) + 12 bulk posts
// (T0+1001..1012) = 14 events. First visit mirrors the newest 10.
const bobEvents: NostrEvent[] = [
  fixtures.profiles.bob,
  fixtures.posts.bobFirst,
  ...fixtures.extras.bulkBob,
] as NostrEvent[];

async function bobCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE pubkey = ?",
  )
    .bind(BOB_PK)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

afterEach(async () => {
  resetMockRelay();
  await defaultCache().delete(npubCooldownKey(BOB_PK));
});

describe("nostrbook.net/npub1… (on-demand mirror)", () => {
  it("404s a shape-valid npub with a bad checksum without touching relays", async () => {
    const res = await SELF.fetch(
      `https://nostrbook.net/npub1${"z".repeat(58)}`,
    );
    expect(res.status).toBe(404);
  });

  it("404s non-npub garbage paths", async () => {
    const res = await SELF.fetch("https://nostrbook.net/not-an-npub");
    expect(res.status).toBe(404);
  });

  it("redirects a claimed pubkey's npub to its subdomain", async () => {
    await seedAlice();
    const res = await SELF.fetch(`https://nostrbook.net/${aliceNpub}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://alice.nostrbook.net/");

    const post = await SELF.fetch(
      `https://nostrbook.net/${aliceNpub}/hello-world`,
      { redirect: "manual" },
    );
    expect(post.status).toBe(302);
    expect(post.headers.get("location")).toBe(
      "https://alice.nostrbook.net/hello-world",
    );
  });

  it("404s a blocked pubkey's npub", async () => {
    await seedBlockedMallory();
    const res = await SELF.fetch(`https://nostrbook.net/${malloryNpub}`);
    expect(res.status).toBe(404);
  });

  it("mirrors the newest 10 events on first visit, backfills on the next", async () => {
    serveEvents(bobEvents);

    // First visit: synchronous fetch+mirror, capped at the newest 10.
    const r1 = await SELF.fetch(`https://nostrbook.net/${bobNpub}`);
    expect(r1.status).toBe(200);
    const html1 = await r1.text();
    expect(html1).toContain("Bulk post 12");
    expect(html1).toContain(`href="/${bobNpub}/bulk-12"`); // basePath links
    expect(await bobCount()).toBe(NPUB_MIRROR_CAP); // 10, not 14

    // Second visit (cooldown cleared): served from D1 immediately, backfill
    // runs via ctx.waitUntil and mirrors the remaining 4 events.
    await defaultCache().delete(npubCooldownKey(BOB_PK));
    const r2 = await SELF.fetch(`https://nostrbook.net/${bobNpub}`);
    expect(r2.status).toBe(200);
    await vi.waitFor(async () => {
      expect(await bobCount()).toBe(bobEvents.length); // all 14
    });

    // With the profile now mirrored, the header shows bob's kind 0 name.
    await defaultCache().delete(npubCooldownKey(BOB_PK));
    const html3 = await (
      await SELF.fetch(`https://nostrbook.net/${bobNpub}`)
    ).text();
    expect(html3).toContain("bob-test");
    expect(html3).toContain("Bob&#39;s first post");
  });

  it("serves a mirrored post page under the npub base path", async () => {
    serveEvents(bobEvents);
    await SELF.fetch(`https://nostrbook.net/${bobNpub}`); // seeds newest 10

    const res = await SELF.fetch(
      `https://nostrbook.net/${bobNpub}/bulk-12`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Bulk post 12");
    expect(html).toContain("Bulk body 12.");

    const missing = await SELF.fetch(
      `https://nostrbook.net/${bobNpub}/no-such-slug`,
    );
    expect(missing.status).toBe(404);
  });

  it("serves valid RSS under the npub base path", async () => {
    serveEvents(bobEvents);
    await SELF.fetch(`https://nostrbook.net/${bobNpub}`);
    const res = await SELF.fetch(
      `https://nostrbook.net/${bobNpub}/rss.xml`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/rss+xml");
    const xml = await res.text();
    expect(xml).toContain(
      `<link>https://nostrbook.net/${bobNpub}/bulk-12</link>`,
    );
  });
});
