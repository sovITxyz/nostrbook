// Feed/sitemap builders: d-tagless (slug "") posts are non-addressable —
// their URL would collapse onto the blog home — so they must be excluded
// from RSS/Atom items and sitemap <loc>s (NIP-23 permits one d-tagless
// replaceable event per author; the D1 schema defaults d_tag to "").
import { describe, expect, it } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import { rssFeed, atomFeed, sitemapXml } from "../../src/views/tenant/xml";
import type { NostrEvent } from "../../src/nostr/event";
import fixtures from "../fixtures/events.json";

const hello = fixtures.posts.aliceHello as NostrEvent;
// Same event with the d tag removed → postMeta slug "".
const dTagless: NostrEvent = {
  ...hello,
  tags: hello.tags.filter((t) => t[0] !== "d"),
};

const opts = {
  title: "alice-test",
  description: "test blog",
  baseUrl: "https://alice.nbread.lol",
  handle: "alice",
  posts: [hello, dTagless],
};

describe("d-tagless posts are excluded from feeds and sitemap", () => {
  it("rssFeed lists only addressable posts", () => {
    const xml = rssFeed(opts);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain("<link>https://alice.nbread.lol/hello-world</link>");
    // no item link collapsing onto the blog home
    expect(xml).not.toContain("<link>https://alice.nbread.lol/</link>\n<guid");
    expect(xml.match(/<item>/g)?.length ?? 0).toBe(1);
  });

  it("atomFeed lists only addressable posts", () => {
    const xml = atomFeed(opts);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml.match(/<entry>/g)?.length ?? 0).toBe(1);
    expect(xml).toContain("<id>https://alice.nbread.lol/hello-world</id>");
  });

  it("sitemapXml never emits the home <loc> twice", () => {
    const xml = sitemapXml({ baseUrl: opts.baseUrl, posts: opts.posts });
    expect(XMLValidator.validate(xml)).toBe(true);
    const homeLocs = xml.match(
      /<loc>https:\/\/alice\.nbread\.lol\/<\/loc>/g,
    );
    expect(homeLocs?.length ?? 0).toBe(1);
    expect(xml).toContain("<loc>https://alice.nbread.lol/hello-world</loc>");
  });

  it("feeds with ONLY a d-tagless post degrade to valid empty feeds", () => {
    const only = { ...opts, posts: [dTagless] };
    expect(XMLValidator.validate(rssFeed(only))).toBe(true);
    expect(XMLValidator.validate(atomFeed(only))).toBe(true);
    const sitemap = sitemapXml({ baseUrl: opts.baseUrl, posts: [dTagless] });
    expect(XMLValidator.validate(sitemap)).toBe(true);
    expect(sitemap.match(/<url>/g)?.length ?? 0).toBe(1); // home only
  });
});
