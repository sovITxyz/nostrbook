// P6 discover feed (nbread.lol/discover) + polished landing, end-to-end
// via SELF.fetch. Exercises the cross-tenant scoping trap: the events table
// also holds unclaimed-npub mirrors and soft-deleted rows — none of those may
// ever surface here.
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import type { NostrEvent } from "../../src/nostr/event";
import { mirrorEvent } from "../../src/services/mirror";
import {
  DISCOVER_MAX_PAGE,
  DISCOVER_PAGE_SIZE,
  FEED_CONTENT_PREFIX_CHARS,
  listRecentClaimedPosts,
} from "../../src/services/events";
import {
  DISCOVER_RATE_MAX,
  DISCOVER_RATE_WINDOW_SECONDS,
} from "../../src/routes/main";
import { CACHE_STATUS_HEADER } from "../../src/middleware/cache";
import {
  ALICE_PK,
  MALLORY_SK,
  findXssVectors,
  resetDiscoverCache,
  resetMirrorState,
  resetRateLimits,
  resetUsers,
  seedAlice,
  seedBlockedMallory,
  seedBob,
  signPostEvent,
} from "../helpers";

const aliceHello = fixtures.posts.aliceHello as NostrEvent;
const aliceTorture = fixtures.posts.aliceTorture as NostrEvent;
const aliceXss = fixtures.posts.aliceXss as NostrEvent;
const bobFirst = fixtures.posts.bobFirst as NostrEvent;
const deleteHello = fixtures.delete as NostrEvent;
const floodAlice = fixtures.extras.floodAlice as NostrEvent[];

/** d tag of a fixture event ("" when absent). */
function dTagOf(ev: NostrEvent): string {
  return ev.tags.find((t) => t[0] === "d")?.[1] ?? "";
}

let rawSeq = 0;

/**
 * Insert a post row DIRECTLY into events (bypassing mirrorEvent) so specs can
 * plant rows for authors without committed fixture keys (unclaimed pubkeys,
 * NULL-handle users) and rows in states mirrorEvent would never produce
 * (deleted=1 WITH a lingering FTS row). Returns the event id.
 */
async function insertRawPost(opts: {
  pubkey: string;
  d: string;
  title: string;
  summary?: string;
  content?: string;
  created_at: number;
  deleted?: boolean;
  fts?: boolean;
}): Promise<string> {
  const id = String(++rawSeq).padStart(4, "0") + "e".repeat(60);
  const tags: string[][] = [
    ["d", opts.d],
    ["title", opts.title],
  ];
  if (opts.summary !== undefined) tags.push(["summary", opts.summary]);
  await env.DB.prepare(
    `INSERT INTO events (id, pubkey, kind, d_tag, created_at, content, tags, sig, raw, deleted, rendered)
     VALUES (?, ?, 30023, ?, ?, ?, ?, 'rawsig', '{}', ?, '<p>raw</p>')`,
  )
    .bind(
      id,
      opts.pubkey,
      opts.d,
      opts.created_at,
      opts.content ?? "raw body",
      JSON.stringify(tags),
      opts.deleted ? 1 : 0,
    )
    .run();
  if (opts.fts !== false) {
    await env.DB.prepare(
      `INSERT INTO posts_fts (rowid, title, summary, content)
       SELECT rowid, ?, ?, ? FROM events WHERE id = ?`,
    )
      .bind(opts.title, opts.summary ?? "", opts.content ?? "raw body", id)
      .run();
  }
  return id;
}

/** Batch-seed the 65 floodAlice fixture posts without per-event crypto. */
async function seedFlood(): Promise<void> {
  await env.DB.batch(
    floodAlice.map((ev) =>
      env.DB.prepare(
        `INSERT INTO events (id, pubkey, kind, d_tag, created_at, content, tags, sig, raw, deleted, rendered)
         VALUES (?, ?, 30023, ?, ?, ?, ?, ?, '{}', 0, '<p>flood</p>')`,
      ).bind(
        ev.id,
        ev.pubkey,
        dTagOf(ev),
        ev.created_at,
        ev.content,
        JSON.stringify(ev.tags),
        ev.sig,
      ),
    ),
  );
}

async function getDiscover(path = "/discover"): Promise<Response> {
  return SELF.fetch(`https://nbread.lol${path}`);
}

describe("discover feed (P6)", () => {
  beforeEach(async () => {
    await resetMirrorState();
    await resetUsers();
    await resetRateLimits();
    await resetDiscoverCache();
    await seedAlice();
    await seedBob();
    await seedBlockedMallory();
    for (const ev of [aliceHello, aliceTorture, aliceXss, bobFirst]) {
      expect(await mirrorEvent(env, ev, { bumpGen: false })).toBe("stored");
    }
  });

  it("lists posts by claimed users newest first, linking to blog URLs", async () => {
    const res = await getDiscover();
    expect(res.status).toBe(200);
    const html = await res.text();
    // created_at DESC: bobFirst (…400) > aliceXss (…300) > aliceTorture (…200)
    // > aliceHello (…100), asserted via each post's absolute blog URL.
    const order = [
      'href="https://bob.nbread.lol/bob-first"',
      'href="https://alice.nbread.lol/xss-test"',
      'href="https://alice.nbread.lol/markdown-torture"',
      'href="https://alice.nbread.lol/hello-world"',
    ].map((needle) => {
      const at = html.indexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      return at;
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Author attribution links to the blog home.
    expect(html).toContain("@bob");
    expect(html).toContain("@alice");
    expect(html).toContain('href="https://alice.nbread.lol/"');
    // Titles/summaries come from tag strings as escaped text.
    expect(html).toContain("Markdown torture test");
    expect(html).toContain("Every markdown feature in one post");
  });

  it("escapes hostile titles/summaries (XSS fixture present, declawed)", async () => {
    const html = await (await getDiscover()).text();
    expect(html).toContain("&lt;script&gt;"); // aliceXss title, escaped
    expect(findXssVectors(html, "page")).toEqual([]);
  });

  it("matches the snapshot", async () => {
    const html = await (await getDiscover()).text();
    expect(html).toMatchSnapshot();
  });

  it("sends a short public s-maxage cache header (no KV involved)", async () => {
    const res = await getDiscover();
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300");
  });

  describe("Cache API + per-IP rate limit (review fix)", () => {
    // Premise of the fix: a Worker-generated response is NEVER edge-cached
    // by s-maxage alone — /discover must do its own caches.default put and
    // back it with a per-IP limit or every request runs the D1 feed query.

    it("serves repeats from the Cache API: miss, then hit, cache-buster immune", async () => {
      const first = await getDiscover();
      expect(first.status).toBe(200);
      expect(first.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
      const firstBody = await first.text();

      const second = await getDiscover();
      expect(second.status).toBe(200);
      expect(second.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
      // Hits keep the shared-cache header and byte-identical content.
      expect(second.headers.get("Cache-Control")).toBe(
        "public, s-maxage=300",
      );
      expect(await second.text()).toBe(firstBody);

      // The key is built from the CLAMPED page only: cache-buster params and
      // garbage pages that clamp to 1 cannot force a fresh D1 query.
      const busted = await getDiscover("/discover?page=1&cb=12345");
      expect(busted.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
      const clamped = await getDiscover("/discover?page=abc&x=y");
      expect(clamped.headers.get(CACHE_STATUS_HEADER)).toBe("hit");
    });

    it("rate limits cache MISSES per IP with a 429 page (never 5xx); hits stay free", async () => {
      const ip = "203.0.113.99";
      // Exhaust the IP's current fixed window directly in D1. Retry once in
      // case the window flips mid-test (same pattern as the search spec).
      for (let attempt = 0; attempt < 2; attempt++) {
        // Fresh cache per attempt (a flipped-window attempt would otherwise
        // find page 2 already cached and read a hit instead of a 429).
        await resetDiscoverCache();
        // Prime page 1 into the cache (another client's budget).
        expect((await getDiscover()).status).toBe(200);
        const now = Math.floor(Date.now() / 1000);
        const windowStart = now - (now % DISCOVER_RATE_WINDOW_SECONDS);
        await env.DB.prepare(
          `INSERT INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET count = excluded.count,
             window_start = excluded.window_start`,
        )
          .bind(`discover:ip:${ip}`, DISCOVER_RATE_MAX, windowStart)
          .run();

        // A cache HIT never touches the limiter — still 200 for this IP.
        const hit = await SELF.fetch("https://nbread.lol/discover", {
          headers: { "CF-Connecting-IP": ip },
        });
        expect(hit.status).toBe(200);
        expect(hit.headers.get(CACHE_STATUS_HEADER)).toBe("hit");

        // An uncached page (miss) is denied with a friendly 429 page.
        const denied = await SELF.fetch(
          "https://nbread.lol/discover?page=2",
          { headers: { "CF-Connecting-IP": ip } },
        );
        if (denied.status === 200 && attempt === 0) continue; // window flipped
        expect(denied.status).toBe(429);
        const html = await denied.text();
        expect(html).toContain("Too many requests");
        expect(findXssVectors(html, "page")).toEqual([]);
        // The 429 was NOT cached: another client misses page 2 fresh (200).
        const other = await SELF.fetch(
          "https://nbread.lol/discover?page=2",
          { headers: { "CF-Connecting-IP": "203.0.113.98" } },
        );
        expect(other.status).toBe(200);
        expect(other.headers.get(CACHE_STATUS_HEADER)).toBe("miss");
        return;
      }
      throw new Error("rate limit never engaged (window flipped twice?)");
    });
  });

  it("breaks created_at ties deterministically by id ASC", async () => {
    const tieA = signPostEvent({
      d: "tie-a",
      title: "Tie post alpha",
      content: "tie alpha body",
      created_at: 1700003000,
    });
    const tieB = signPostEvent({
      d: "tie-b",
      title: "Tie post beta",
      content: "tie beta body",
      created_at: 1700003000,
    });
    expect(await mirrorEvent(env, tieA, { bumpGen: false })).toBe("stored");
    expect(await mirrorEvent(env, tieB, { bumpGen: false })).toBe("stored");
    const [first, second] =
      tieA.id < tieB.id
        ? ["Tie post alpha", "Tie post beta"]
        : ["Tie post beta", "Tie post alpha"];
    const html = await (await getDiscover()).text();
    expect(html.indexOf(first)).toBeGreaterThan(-1);
    expect(html.indexOf(first)).toBeLessThan(html.indexOf(second));
    // Service-level: same order, and the tie pair sorts before older posts.
    const rows = await listRecentClaimedPosts(env);
    expect(rows[0]?.created_at).toBe(1700003000);
    expect(rows[1]?.created_at).toBe(1700003000);
    expect(rows[0]!.id < rows[1]!.id).toBe(true);
  });

  describe("scope (the P6 trap)", () => {
    it("excludes posts by blocked users", async () => {
      const mallory = signPostEvent({
        sk: MALLORY_SK,
        d: "mallory-post",
        title: "Mallory blocked-author post",
        content: "should never surface",
        created_at: 1700000999,
      });
      expect(await mirrorEvent(env, mallory, { bumpGen: false })).toBe(
        "stored",
      );
      const html = await (await getDiscover()).text();
      expect(html).not.toContain("Mallory blocked-author post");
    });

    it("excludes posts mirrored for unclaimed pubkeys (no users row)", async () => {
      await insertRawPost({
        pubkey: "c".repeat(64),
        d: "unclaimed-post",
        title: "Unclaimed npub post",
        created_at: 1700009000,
      });
      const html = await (await getDiscover()).text();
      expect(html).not.toContain("Unclaimed npub post");
    });

    it("excludes posts by users with a NULL handle (signed in, never claimed)", async () => {
      const pk = "d".repeat(64);
      await env.DB.prepare(
        "INSERT INTO users (pubkey, handle, claimed_at) VALUES (?, NULL, ?)",
      )
        .bind(pk, new Date().toISOString())
        .run();
      await insertRawPost({
        pubkey: pk,
        d: "null-handle-post",
        title: "Handleless author post",
        created_at: 1700009001,
      });
      const html = await (await getDiscover()).text();
      expect(html).not.toContain("Handleless author post");
    });

    it("excludes soft-deleted rows", async () => {
      await insertRawPost({
        pubkey: ALICE_PK,
        d: "tombstoned-post",
        title: "Tombstoned post",
        created_at: 1700009002,
        deleted: true,
      });
      const html = await (await getDiscover()).text();
      expect(html).not.toContain("Tombstoned post");
    });

    it("drops a post from the feed once its kind 5 delete is mirrored", async () => {
      let html = await (await getDiscover()).text();
      expect(html).toContain('href="https://alice.nbread.lol/hello-world"');
      expect(await mirrorEvent(env, deleteHello, { bumpGen: false })).toBe(
        "stored",
      );
      // The first fetch cached page 1; purge so the refetch reflects the
      // delete NOW instead of after the 300s TTL (accepted product behavior).
      await resetDiscoverCache();
      html = await (await getDiscover()).text();
      expect(html).not.toContain(
        'href="https://alice.nbread.lol/hello-world"',
      );
      // The others stay.
      expect(html).toContain('href="https://bob.nbread.lol/bob-first"');
    });
  });

  describe("pagination", () => {
    beforeEach(async () => {
      await seedFlood(); // 65 alice posts, created_at 1700002001..1700002065
    });

    it("pages are stable at the boundary (20/page, keyed created_at DESC, id ASC)", async () => {
      // 65 flood posts sort above the 4 base posts → page 1 = flood 65..46.
      const page1 = await (await getDiscover("/discover")).text();
      expect(page1).toContain("Flood post 65");
      expect(page1).toContain("Flood post 46");
      expect(page1).not.toContain("Flood post 45");
      expect(page1).toContain('rel="next"');
      expect(page1).not.toContain('rel="prev"');

      const page2 = await (await getDiscover("/discover?page=2")).text();
      expect(page2).toContain("Flood post 45");
      expect(page2).toContain("Flood post 26");
      expect(page2).not.toContain("Flood post 46");
      expect(page2).not.toContain("Flood post 25");
      expect(page2).toContain('rel="next"');
      expect(page2).toContain('rel="prev"');

      // Page 4 = flood 05..01 + the 4 base posts (69 rows total) — last page.
      const page4 = await (await getDiscover("/discover?page=4")).text();
      expect(page4).toContain("Flood post 05");
      expect(page4).toContain("Flood post 01");
      expect(page4).toContain('href="https://alice.nbread.lol/hello-world"');
      expect(page4).not.toContain('rel="next"');
      expect(page4).toContain('rel="prev"');
    });

    it("clamps garbage, negative and out-of-range page params (never 5xx)", async () => {
      for (const q of ["0", "-3", "abc", "1.5", "%20", "9".repeat(300)]) {
        const res = await getDiscover(`/discover?page=${q}`);
        expect(res.status, `page=${q}`).toBe(200);
      }
      // Garbage degrades to page 1…
      const garbage = await (await getDiscover("/discover?page=abc")).text();
      expect(garbage).toContain("Flood post 65");
      // …absurd depth clamps to DISCOVER_MAX_PAGE (an empty page here).
      const deep = await getDiscover("/discover?page=999999");
      expect(deep.status).toBe(200);
      const deepHtml = await deep.text();
      expect(deepHtml).toContain("No posts here yet.");
      expect(deepHtml).not.toContain('rel="next"');
      // The clamped page links back to the previous (valid) page.
      expect(deepHtml).toContain(`/discover?page=${DISCOVER_MAX_PAGE - 1}`);
    });

    it("service-level: feed rows are a slim projection (no raw/rendered/sig/content tail)", async () => {
      // Review fix: SELECT e.* hauled up to ~100KiB per row (content +
      // rendered + raw) through D1 on the PUBLIC path; the feed only renders
      // tag metadata plus a bounded content prefix for the title fallback.
      const rows = await listRecentClaimedPosts(env);
      expect(rows.length).toBeGreaterThan(0);
      for (const heavy of ["raw", "rendered", "sig", "deleted"]) {
        expect(rows[0], heavy).not.toHaveProperty(heavy);
      }
    });

    it("service-level: limit/offset are clamped, ordering fully specified", async () => {
      // Negative/garbage limits and offsets cannot go unbounded.
      const rows = await listRecentClaimedPosts(env, -5, -100);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(DISCOVER_PAGE_SIZE + 1);
      const all = await listRecentClaimedPosts(env, DISCOVER_PAGE_SIZE + 1, 0);
      const sorted = [...all].sort(
        (a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1),
      );
      expect(all.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
    });
  });

  describe("slim projection: content prefix (review fix)", () => {
    it("truncates content to the title-fallback prefix; headings within it still title the item", async () => {
      // A TITLE-LESS post: the feed title must come from the first heading
      // inside the bounded content prefix — the one reason content is
      // fetched at all.
      const id = "9".repeat(4) + "a".repeat(60);
      const longBody = `# Heading from content\n\n${"x".repeat(FEED_CONTENT_PREFIX_CHARS * 2)}`;
      await env.DB.prepare(
        `INSERT INTO events (id, pubkey, kind, d_tag, created_at, content, tags, sig, raw, deleted, rendered)
         VALUES (?, ?, 30023, 'titleless', 1700009900, ?, '[["d","titleless"]]', 'rawsig', '{}', 0, '<p>x</p>')`,
      )
        .bind(id, ALICE_PK, longBody)
        .run();
      const rows = await listRecentClaimedPosts(env);
      const row = rows.find((r) => r.id === id);
      expect(row).toBeDefined();
      expect(row!.content.length).toBe(FEED_CONTENT_PREFIX_CHARS);
      const html = await (await getDiscover()).text();
      expect(html).toContain("Heading from content");
    });
  });
});

describe("landing page (P6 polish)", () => {
  it("pitches the product and carries the login CTA", async () => {
    const res = await SELF.fetch("https://nbread.lol/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("nbread.lol");
    expect(html).toContain('href="/login"');
    expect(html).toContain('href="/discover"');
    expect(html).toContain('href="/search"');
    expect(html).toMatchSnapshot();
  });
});
