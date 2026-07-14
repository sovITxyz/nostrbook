// P6 search (nbread.lol/search + services/search) end-to-end via
// SELF.fetch and direct service calls: canned queries over fixtures, the
// MATCH injection corpus (never a 5xx), strict echo escaping, discover-equal
// scoping, and the per-IP rate limit.
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import type { NostrEvent } from "../../src/nostr/event";
import { mirrorEvent } from "../../src/services/mirror";
import { searchPosts, toMatchQuery } from "../../src/services/search";
import {
  SEARCH_RATE_MAX,
  SEARCH_RATE_WINDOW_SECONDS,
} from "../../src/routes/main";
import {
  ALICE_PK,
  ALICE_SK,
  BOB_SK,
  MALLORY_SK,
  MATCH_INJECTION_CORPUS,
  findXssVectors,
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

let ipSeq = 0;

/** GET /search with a fresh client IP so tests never trip each other's window. */
async function getSearch(q?: string, ip?: string): Promise<Response> {
  const query = q === undefined ? "" : `?q=${encodeURIComponent(q)}`;
  return SELF.fetch(`https://nbread.lol/search${query}`, {
    headers: { "CF-Connecting-IP": ip ?? `10.6.0.${++ipSeq % 250}` },
  });
}

/**
 * XSS scan for SEARCH pages: the page legitimately ships its own <form>
 * (which findXssVectors' page mode forbids — blog pages never carry forms).
 * The element is allowed by NAME only; every tag, the form included, still
 * goes through the on*-attribute and dangerous-URL checks.
 */
function searchPageXssVectors(html: string): string[] {
  return findXssVectors(html, "page").filter(
    (finding) => finding !== "forbidden element: <form",
  );
}

/**
 * searchPosts asserting the backend did not degrade (`null` means a real
 * D1/FTS failure since the review fix — see the "degraded backend" block).
 */
async function searchRows(q: string) {
  const rows = await searchPosts(env, q);
  expect(rows).not.toBeNull();
  return rows!;
}

let rawSeq = 0;

/** Direct events + posts_fts insert (see discover.spec.ts for rationale). */
async function insertRawPost(opts: {
  pubkey: string;
  d: string;
  title: string;
  content?: string;
  created_at: number;
  deleted?: boolean;
}): Promise<void> {
  const id = String(++rawSeq).padStart(4, "0") + "f".repeat(60);
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
      JSON.stringify([
        ["d", opts.d],
        ["title", opts.title],
      ]),
      opts.deleted ? 1 : 0,
    )
    .run();
  // FTS row ON PURPOSE even for deleted rows: search must be scoped by the
  // events/users join, not by FTS-row hygiene.
  await env.DB.prepare(
    `INSERT INTO posts_fts (rowid, title, summary, content)
     SELECT rowid, ?, '', ? FROM events WHERE id = ?`,
  )
    .bind(opts.title, opts.content ?? "raw body", id)
    .run();
}

describe("search (P6)", () => {
  beforeEach(async () => {
    await resetMirrorState();
    await resetUsers();
    await resetRateLimits();
    await seedAlice();
    await seedBob();
    await seedBlockedMallory();
    for (const ev of [aliceHello, aliceTorture, aliceXss, bobFirst]) {
      expect(await mirrorEvent(env, ev, { bumpGen: false })).toBe("stored");
    }
  });

  describe("search page", () => {
    it("serves the bare form without a query (no results section)", async () => {
      const res = await getSearch();
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('name="q"');
      expect(html).not.toContain("No posts matched");
      expect(html).toMatchSnapshot();
    });

    it("treats a whitespace-only query as no query", async () => {
      const res = await getSearch("   ");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("No posts matched");
    });

    it("renders results with links to the posts' blog URLs", async () => {
      const res = await getSearch("hello");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('href="https://alice.nbread.lol/hello-world"');
      expect(html).toContain("Hello world");
      expect(html).not.toContain("bob-first");
      expect(html).toMatchSnapshot();
    });

    it("shows an empty state for a query matching nothing", async () => {
      const res = await getSearch("nonexistentzzz");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("No posts matched");
    });

    it("echoes the query strictly escaped (hostile echo, no XSS vectors)", async () => {
      const hostile = `<script>alert(1)</script>" onmouseover="x`;
      const res = await getSearch(hostile);
      expect(res.status).toBe(200);
      const html = await res.text();
      // Text context: `<` comes out escaped, no real tag opens.
      expect(html).toContain("&lt;script&gt;");
      expect(html.toLowerCase()).not.toContain("<script>alert");
      // Attribute context (the form input echoes the query in value=""): the
      // payload's quote must be escaped — a raw `" onmouseover="` sequence
      // would mean attribute breakout. findXssVectors is not used here: its
      // tag-scan heuristic cannot tell escaped `&quot; onmouseover=` INSIDE
      // an attribute value (inert) from a real breakout, so assert on the
      // raw breakout pattern directly.
      expect(html).not.toContain('" onmouseover="');
      expect(html).toContain("&quot; onmouseover=&quot;x");
    });
  });

  describe("canned queries over fixtures", () => {
    it('"torture" matches both torture-titled posts (set assertion)', async () => {
      const rows = await searchRows("torture");
      expect(new Set(rows.map((r) => r.id))).toEqual(
        new Set([aliceTorture.id, aliceXss.id]),
      );
    });

    it('"markdown feature" ANDs terms across title and summary', async () => {
      const rows = await searchRows("markdown feature");
      expect(rows.map((r) => r.id)).toEqual([aliceTorture.id]);
    });

    it("porter stemming: 'authors' matches bob's 'author' summary", async () => {
      const rows = await searchRows("authors");
      expect(rows.map((r) => r.id)).toEqual([bobFirst.id]);
    });

    it("results carry the author handle for URL building", async () => {
      const rows = await searchRows("hello");
      expect(rows.map((r) => [r.id, r.handle])).toEqual([
        [aliceHello.id, "alice"],
      ]);
    });

    it("bm25 ties fall back to created_at DESC with id ASC tie-break", async () => {
      // Three docs STRUCTURALLY IDENTICAL for the term (same tf per column,
      // same token counts, no summary) → equal bm25 scores, so ordering must
      // fall through to the deterministic created_at DESC, id ASC tail.
      const older = signPostEvent({
        sk: BOB_SK,
        d: "zebra-old",
        title: "Zebraword tie C",
        content: "zebraword body",
        created_at: 1700005000,
      });
      const tieA = signPostEvent({
        sk: ALICE_SK,
        d: "zebra-tie-a",
        title: "Zebraword tie A",
        content: "zebraword body",
        created_at: 1700006000,
      });
      const tieB = signPostEvent({
        sk: ALICE_SK,
        d: "zebra-tie-b",
        title: "Zebraword tie B",
        content: "zebraword body",
        created_at: 1700006000,
      });
      for (const ev of [older, tieA, tieB]) {
        expect(await mirrorEvent(env, ev, { bumpGen: false })).toBe("stored");
      }
      const [firstTie, secondTie] =
        tieA.id < tieB.id ? [tieA.id, tieB.id] : [tieB.id, tieA.id];
      const rows = await searchRows("zebraword");
      expect(rows.map((r) => r.id)).toEqual([firstTie, secondTie, older.id]);
      // Stable across identical queries (no hidden nondeterminism).
      const again = await searchRows("zebraword");
      expect(again.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    });

    it("bm25: an older title match outranks a newer content-only match", async () => {
      // Inverts the old recency ordering: title carries weight 10 vs 1 for
      // content, so the buried body hit loses despite being newer.
      const titledOlder = signPostEvent({
        sk: ALICE_SK,
        d: "quokka-titled",
        title: "Quokkaword field notes",
        content: "A body that never mentions the search term.",
        created_at: 1700001000,
      });
      const buriedNewer = signPostEvent({
        sk: BOB_SK,
        d: "quokka-buried",
        title: "Completely unrelated title",
        content:
          "Opening paragraph about something else entirely. " +
          "More filler prose to pad the body out further still. " +
          "Only here, deep in the content, does quokkaword appear once.",
        created_at: 1700009000,
      });
      for (const ev of [titledOlder, buriedNewer]) {
        expect(await mirrorEvent(env, ev, { bumpGen: false })).toBe("stored");
      }
      const rows = await searchRows("quokkaword");
      expect(rows.map((r) => r.id)).toEqual([titledOlder.id, buriedNewer.id]);
    });
  });

  describe("scope (identical to discover)", () => {
    it("excludes blocked users' posts even with live FTS rows", async () => {
      const mallory = signPostEvent({
        sk: MALLORY_SK,
        d: "mallory-search",
        title: "Mallorysecretword post",
        content: "mallorysecretword body",
        created_at: 1700000999,
      });
      expect(await mirrorEvent(env, mallory, { bumpGen: false })).toBe(
        "stored",
      );
      // The FTS row EXISTS (mirrorEvent indexed it) — the users join must
      // still filter it out.
      const fts = await env.DB.prepare(
        "SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?",
      )
        .bind('"mallorysecretword"')
        .all();
      expect(fts.results.length).toBe(1);
      expect(await searchPosts(env, "mallorysecretword")).toEqual([]);
      const html = await (await getSearch("mallorysecretword")).text();
      expect(html).toContain("No posts matched");
    });

    it("excludes unclaimed-npub posts (no users row)", async () => {
      await insertRawPost({
        pubkey: "c".repeat(64),
        d: "unclaimed-search",
        title: "Unclaimedsecretword post",
        content: "unclaimedsecretword body",
        created_at: 1700009000,
      });
      expect(await searchPosts(env, "unclaimedsecretword")).toEqual([]);
    });

    it("excludes NULL-handle users' posts", async () => {
      const pk = "d".repeat(64);
      await env.DB.prepare(
        "INSERT INTO users (pubkey, handle, claimed_at) VALUES (?, NULL, ?)",
      )
        .bind(pk, new Date().toISOString())
        .run();
      await insertRawPost({
        pubkey: pk,
        d: "nullhandle-search",
        title: "Handlelesssecretword post",
        content: "handlelesssecretword body",
        created_at: 1700009001,
      });
      expect(await searchPosts(env, "handlelesssecretword")).toEqual([]);
    });

    it("excludes deleted posts even when a stale FTS row lingers", async () => {
      await insertRawPost({
        pubkey: ALICE_PK,
        d: "tombstone-search",
        title: "Tombstonesecretword post",
        content: "tombstonesecretword body",
        created_at: 1700009002,
        deleted: true,
      });
      expect(await searchPosts(env, "tombstonesecretword")).toEqual([]);
    });
  });

  describe("MATCH injection corpus", () => {
    it("every hostile query returns HTTP 200 with safe/empty results", async () => {
      for (const raw of MATCH_INJECTION_CORPUS) {
        const res = await getSearch(raw);
        expect(res.status, `q=${JSON.stringify(raw)}`).toBe(200);
        const html = await res.text();
        expect(searchPageXssVectors(html), `q=${JSON.stringify(raw)}`).toEqual(
          [],
        );
      }
    });

    it("searchPosts never throws on the corpus", async () => {
      for (const raw of MATCH_INJECTION_CORPUS) {
        const rows = await searchPosts(env, raw);
        expect(Array.isArray(rows), `q=${JSON.stringify(raw)}`).toBe(true);
      }
    });

    it("sanitized corpus output is accepted by FTS5 MATCH verbatim", async () => {
      // Strict check that does NOT rely on searchPosts' defensive catch: the
      // sanitizer's output must be a valid FTS5 expression by itself.
      for (const raw of MATCH_INJECTION_CORPUS) {
        const match = toMatchQuery(raw);
        if (match === "") continue;
        await expect(
          env.DB.prepare("SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?")
            .bind(match)
            .all(),
          `match=${JSON.stringify(match)}`,
        ).resolves.toBeTruthy();
      }
    });

    it("operators are inert: 'hello OR nonexistentzzz' is an AND of terms", async () => {
      // If OR still worked as an operator this would return aliceHello.
      expect(await searchPosts(env, "hello OR nonexistentzzz")).toEqual([]);
    });

    it("column filters are inert: 'title:hello' does not target the title column", async () => {
      // As a real column filter this would match aliceHello ("Hello world");
      // sanitized it is the AND of terms "title" and "hello" → no match.
      expect(await searchPosts(env, "title:hello")).toEqual([]);
    });
  });

  describe("rate limit", () => {
    it(`denies the ${SEARCH_RATE_MAX + 1}th query in a window with a 429 page (not a 5xx)`, async () => {
      const ip = "203.0.113.77";
      const key = `search:ip:${ip}`;
      // Pre-fill the current fixed window to the cap instead of sending 30
      // real requests. Retry once if the window flips mid-test.
      for (let attempt = 0; attempt < 2; attempt++) {
        const now = Math.floor(Date.now() / 1000);
        const windowStart =
          now - (now % SEARCH_RATE_WINDOW_SECONDS);
        await env.DB.prepare(
          `INSERT INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET count = excluded.count,
             window_start = excluded.window_start`,
        )
          .bind(key, SEARCH_RATE_MAX, windowStart)
          .run();
        const res = await getSearch("hello", ip);
        if (res.status === 200 && attempt === 0) continue; // window flipped
        expect(res.status).toBe(429);
        const html = await res.text();
        expect(html).toContain("Too many searches");
        expect(searchPageXssVectors(html)).toEqual([]);
        return;
      }
      throw new Error("rate limit never engaged (window flipped twice?)");
    });

    it("does not spend rate-limit budget on the bare form", async () => {
      const ip = "203.0.113.78";
      await getSearch(undefined, ip);
      const row = await env.DB.prepare(
        "SELECT count FROM rate_limits WHERE key = ?",
      )
        .bind(`search:ip:${ip}`)
        .first<{ count: number }>();
      expect(row).toBeNull();
    });
  });

  describe("degraded backend (review fix)", () => {
    // A REAL D1/FTS failure must be distinguishable from "no results": the
    // service returns null (not []) and the route says so with a 503 —
    // outages stay visible in monitoring instead of reading as empty pages.

    it("searchPosts returns null — NOT [] — when the query itself fails", async () => {
      const broken = {
        DB: {
          prepare() {
            throw new Error("D1 down (test)");
          },
        },
      } as unknown as Env;
      expect(await searchPosts(broken, "hello")).toBeNull();
    });

    it("route renders a 503 'temporarily unavailable' page on backend failure", async () => {
      // Simulate schema drift / outage by dropping the FTS table; restore in
      // finally so later tests (and this file's beforeEach) see the schema.
      await env.DB.prepare("DROP TABLE posts_fts").run();
      try {
        const res = await getSearch("hello");
        expect(res.status).toBe(503);
        const html = await res.text();
        expect(html).toContain("temporarily unavailable");
        expect(html).not.toContain("No posts matched");
        expect(searchPageXssVectors(html)).toEqual([]);
      } finally {
        await env.DB.prepare(
          "CREATE VIRTUAL TABLE posts_fts USING fts5(title, summary, content, tokenize='porter unicode61')",
        ).run();
      }
    });
  });
});
