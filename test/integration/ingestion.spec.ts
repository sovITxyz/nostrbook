// Full blog end-to-end from fixtures: events seeded through mirrorEvent,
// pages served by SELF.fetch from D1 (the P3 D1-backed TenantDataProvider is
// the default — no provider injection here).
import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import fixtures from "../fixtures/events.json";
import { seedAlice, findXssVectors } from "../helpers";
import { mirrorEvent } from "../../src/services/mirror";
import { getRenderPostCallCount } from "../../src/markdown";
import type { NostrEvent } from "../../src/nostr/event";

const aliceProfile = fixtures.profiles.alice as NostrEvent;
const aliceHello = fixtures.posts.aliceHello as NostrEvent;
const aliceTorture = fixtures.posts.aliceTorture as NostrEvent;
const aliceXss = fixtures.posts.aliceXss as NostrEvent;
const deleteByAlice = fixtures.delete as NostrEvent;

describe("public blog from mirrored events (SELF.fetch, D1 provider)", () => {
  beforeAll(async () => {
    await seedAlice();
    for (const ev of [aliceProfile, aliceHello, aliceTorture, aliceXss]) {
      expect(await mirrorEvent(env, ev)).toBe("stored");
    }
  });

  it("lists mirrored posts on the blog home with the mirrored profile", async () => {
    const res = await SELF.fetch("https://alice.nbread.lol/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Hello world");
    expect(html).toContain("Markdown torture test");
    expect(html).toContain('href="/hello-world"');
    // Profile header comes from the mirrored kind 0 (profiles table):
    expect(html).toContain("alice-test");
    expect(html).toContain('src="https://example.com/alice.png"');
  });

  it("serves the post page from STORED html with zero renderPost calls", async () => {
    const before = getRenderPostCallCount();
    const res = await SELF.fetch("https://alice.nbread.lol/hello-world");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<strong>alice</strong>");
    expect(html).toContain("Hello world");
    // Render-at-ingest contract: the request path performed NO markdown work.
    expect(getRenderPostCallCount()).toBe(before);
  });

  it("neutralizes the XSS post end-to-end through D1", async () => {
    const res = await SELF.fetch("https://alice.nbread.lol/xss-test");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(findXssVectors(html, "page")).toEqual([]);
    expect(html).toContain("&lt;script&gt;"); // payload visible as text
  });

  it("serves valid RSS built from mirrored events", async () => {
    const res = await SELF.fetch("https://alice.nbread.lol/rss.xml");
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain("<title>alice-test</title>");
    expect(xml).toContain(
      "<link>https://alice.nbread.lol/hello-world</link>",
    );
  });

  it("404s a slug that is not mirrored", async () => {
    const res = await SELF.fetch("https://alice.nbread.lol/no-such-post");
    expect(res.status).toBe(404);
  });

  it("hides a post everywhere after its kind 5 delete is mirrored", async () => {
    expect(await mirrorEvent(env, deleteByAlice)).toBe("stored");

    const home = await (
      await SELF.fetch("https://alice.nbread.lol/")
    ).text();
    expect(home).not.toContain("Hello world");
    expect(home).toContain("Markdown torture test"); // others still listed

    const post = await SELF.fetch("https://alice.nbread.lol/hello-world");
    expect(post.status).toBe(404);

    const rss = await (
      await SELF.fetch("https://alice.nbread.lol/rss.xml")
    ).text();
    expect(rss).not.toContain("hello-world");
  });
});
