// P7 security headers: every response carries nosniff + Referrer-Policy, and
// a Content-Security-Policy chosen by HOST CLASS — blog pages (tenant
// subdomains AND apex /npub1… views) get the strict JS-free blog CSP; every
// other apex response gets the apex CSP + X-Frame-Options DENY. Cached
// responses (gen cache for blogs, page cache for /discover) must carry the
// same headers on hit and miss.
import { SELF, env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import { seedAlice, BOB_PK } from "../helpers";
import { mirrorEvent } from "../../src/services/mirror";
import { npubEncode } from "../../src/nostr/nip19";
import { serveEvents, resetMockRelay } from "../mock-relay";
import { CACHE_STATUS_HEADER } from "../../src/middleware/cache";
import {
  APEX_CSP,
  BLOG_CSP,
  REFERRER_POLICY,
  isNpubPath,
} from "../../src/middleware/headers";
import type { NostrEvent } from "../../src/nostr/event";

const aliceProfile = fixtures.profiles.alice as NostrEvent;
const aliceHello = fixtures.posts.aliceHello as NostrEvent;

/** The headers EVERY response must carry, regardless of class. */
function expectBaseline(res: Response): void {
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("Referrer-Policy")).toBe(REFERRER_POLICY);
}

function expectApexClass(res: Response): void {
  expectBaseline(res);
  expect(res.headers.get("Content-Security-Policy")).toBe(APEX_CSP);
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
}

function expectBlogClass(res: Response): void {
  expectBaseline(res);
  expect(res.headers.get("Content-Security-Policy")).toBe(BLOG_CSP);
  // Blogs stay embeddable: no XFO on the blog class.
  expect(res.headers.get("X-Frame-Options")).toBeNull();
}

beforeAll(async () => {
  await seedAlice();
  expect(await mirrorEvent(env, aliceProfile)).toBe("stored");
  expect(await mirrorEvent(env, aliceHello)).toBe("stored");
  // npub views trigger on-demand relay mirroring — serve an empty relay so
  // no real sockets open and the views render the (empty) mirrored state.
  serveEvents([]);
});

afterAll(() => {
  resetMockRelay();
});

describe("isNpubPath (host-class selection)", () => {
  it("matches npub blog paths and nothing else", () => {
    const npub = npubEncode(BOB_PK);
    expect(isNpubPath(`/${npub}`)).toBe(true);
    expect(isNpubPath(`/${npub}/`)).toBe(true);
    expect(isNpubPath(`/${npub}/rss.xml`)).toBe(true);
    expect(isNpubPath(`/${npub}/some-post`)).toBe(true);
    expect(isNpubPath("/")).toBe(false);
    expect(isNpubPath("/discover")).toBe(false);
    expect(isNpubPath("/npub1short")).toBe(false);
    expect(isNpubPath(`/x${npub}`)).toBe(false);
    // 59 chars after npub1 — no longer the fixed-size route shape.
    expect(isNpubPath(`/${npub}a`)).toBe(false);
  });
});

describe("apex class", () => {
  it("landing page carries the exact apex CSP + XFO DENY", async () => {
    const res = await SELF.fetch("https://nbread.lol/");
    expect(res.status).toBe(200);
    expectApexClass(res);
  });

  it("login page (ships JS) still fits inside the apex CSP", async () => {
    const res = await SELF.fetch("https://nbread.lol/login");
    expect(res.status).toBe(200);
    expectApexClass(res);
    // The CSP must actually permit what the page uses: same-origin scripts.
    expect(await res.text()).toContain('src="/js/login.js"');
    expect(APEX_CSP).toContain("script-src 'self'");
    // …and the editor's relay broadcast (wss:) + same-origin fetches.
    expect(APEX_CSP).toContain("connect-src 'self' wss:");
    // …and the Turnstile script + iframe on the dashboard claim form.
    expect(APEX_CSP).toContain("https://challenges.cloudflare.com");
  });

  it("redirects carry headers too (anonymous /dashboard → /login)", async () => {
    const res = await SELF.fetch("https://nbread.lol/dashboard", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expectApexClass(res);
  });

  it("apex 404s carry headers", async () => {
    const res = await SELF.fetch("https://nbread.lol/no-such-page");
    expect(res.status).toBe(404);
    expectApexClass(res);
  });

  it("nostr.json keeps its CORS + content type under the apex class", async () => {
    const res = await SELF.fetch(
      "https://nbread.lol/.well-known/nostr.json?name=alice",
    );
    expect(res.status).toBe(200);
    expectApexClass(res);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("unknown host class (guard 404) gets the strict apex default", async () => {
    const res = await SELF.fetch("https://nbread.lol.evil.com/");
    expect(res.status).toBe(404);
    expectApexClass(res);
  });

  it("unclaimed subdomain (tenant 404) gets the strict apex default", async () => {
    const res = await SELF.fetch("https://unknown.nbread.lol/");
    expect(res.status).toBe(404);
    expectApexClass(res);
  });

  it("/discover carries apex headers on miss AND on cache hit", async () => {
    const miss = await SELF.fetch("https://nbread.lol/discover");
    expect(miss.status).toBe(200);
    expect(miss.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    expectApexClass(miss);

    const hit = await SELF.fetch("https://nbread.lol/discover");
    expect(hit.status).toBe(200);
    expect(hit.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
    expectApexClass(hit);
  });
});

describe("blog class (tenant subdomains)", () => {
  it("blog home carries the exact blog CSP on miss AND on cache hit", async () => {
    const miss = await SELF.fetch("https://alice.nbread.lol/");
    expect(miss.status).toBe(200);
    expect(miss.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
    expectBlogClass(miss);

    const hit = await SELF.fetch("https://alice.nbread.lol/");
    expect(hit.status).toBe(200);
    expect(hit.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
    expectBlogClass(hit);
  });

  it("blog pages serve NO JavaScript (CSP forbids it; markup ships none)", async () => {
    const home = await SELF.fetch("https://alice.nbread.lol/");
    expect((await home.text()).toLowerCase()).not.toContain("<script");
    const post = await SELF.fetch("https://alice.nbread.lol/hello-world");
    expect(post.status).toBe(200);
    expectBlogClass(post);
    expect((await post.text()).toLowerCase()).not.toContain("<script");
    // default-src 'none' with no script-src ⇒ scripts are blocked wholesale.
    expect(BLOG_CSP).not.toContain("script-src");
    expect(BLOG_CSP).toContain("default-src 'none'");
  });

  it("RSS keeps its XML content type + blog-class headers", async () => {
    const res = await SELF.fetch("https://alice.nbread.lol/rss.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/rss+xml; charset=utf-8",
    );
    expectBlogClass(res);
  });

  it("sitemap + robots keep their content types + headers", async () => {
    const sitemap = await SELF.fetch("https://alice.nbread.lol/sitemap.xml");
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("Content-Type")).toBe(
      "application/xml; charset=utf-8",
    );
    expectBlogClass(sitemap);

    const robots = await SELF.fetch("https://alice.nbread.lol/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.headers.get("Content-Type")).toContain("text/plain");
    expectBlogClass(robots);
  });

  it("blog 404s (unknown slug) carry blog-class headers", async () => {
    const res = await SELF.fetch("https://alice.nbread.lol/no-such-post");
    expect(res.status).toBe(404);
    expectBlogClass(res);
  });

  it("blog CSP pins base-uri + form-action (sanitizer defense-in-depth)", async () => {
    // Neither directive falls back to default-src. Blog pages render hostile
    // relay content; the sanitizer drops <base>/<form>, but the CSP must not
    // be silent if the sanitizer ever regresses (review fix).
    expect(BLOG_CSP).toContain("base-uri 'none'");
    expect(BLOG_CSP).toContain("form-action 'none'");
    // …and blog markup legitimately ships neither element, so the pins are
    // free: home + post pages contain no <form>/<base>.
    for (const path of ["/", "/hello-world"]) {
      const res = await SELF.fetch(`https://alice.nbread.lol${path}`);
      const html = (await res.text()).toLowerCase();
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<base");
    }
  });
});

describe("blog class (apex /npub1… views)", () => {
  const bobNpub = npubEncode(BOB_PK);

  it("npub home renders with blog-class headers (no XFO)", async () => {
    const res = await SELF.fetch(`https://nbread.lol/${bobNpub}`);
    expect(res.status).toBe(200);
    expectBlogClass(res);
    expect((await res.text()).toLowerCase()).not.toContain("<script");
  });

  it("npub RSS keeps content type + blog-class headers", async () => {
    const res = await SELF.fetch(`https://nbread.lol/${bobNpub}/rss.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/rss+xml; charset=utf-8",
    );
    expectBlogClass(res);
  });

  it("shape-valid npub with a bad checksum 404s with blog-class headers", async () => {
    const zeds = "z".repeat(58);
    const res = await SELF.fetch(`https://nbread.lol/npub1${zeds}`);
    expect(res.status).toBe(404);
    expectBlogClass(res);
  });
});
