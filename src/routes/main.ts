import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { DispatchEnv } from "../types";
import { MainHome } from "../views/main/home";
import { npubDecode } from "../nostr/nip19";
import { fetchEvents } from "../nostr/relay";
import type { NostrEvent } from "../nostr/event";
import { getUserByPubkey } from "../services/users";
import { bumpGen, mirrorEvent } from "../services/mirror";
import { checkRateLimit } from "../services/ratelimit";
import {
  DISCOVER_MAX_PAGE,
  DISCOVER_PAGE_SIZE,
  getPost as getPostRow,
  listPostsByPubkey,
  listRecentClaimedPosts,
  oldestCreatedAt,
  rowToEvent,
  storedEventIds,
} from "../services/events";
import {
  SEARCH_MAX_QUERY_CHARS,
  searchPosts,
} from "../services/search";
import { rateLimitAllows } from "../services/ratelimit";
import { feedItems } from "../views/main/feed";
import { DiscoverPage } from "../views/main/discover";
import { SearchPage } from "../views/main/search";
import { getProfile as getProfileRow } from "../services/profiles";
import { relayList } from "../cron/refresh";
import { CACHE_STATUS_HEADER, defaultCache } from "../middleware/cache";
import type { BlogProfile } from "../views/tenant/layout";
import { BlogHome } from "../views/tenant/home";
import { PostPage } from "../views/tenant/post";
import { NotFoundPage } from "../views/tenant/not-found";
import { rssFeed, atomFeed } from "../views/tenant/xml";

/** Routes served on the apex (MAIN_HOST). */
export const mainRoutes = new Hono<DispatchEnv>();

mainRoutes.get("/", (c) => c.html(MainHome()));

mainRoutes.get("/healthz", (c) =>
  c.json({ ok: true, service: "nostrbook", environment: c.env.ENVIRONMENT }),
);

// --- nostrbook.net/discover — cross-tenant recent-posts feed (P6) -------------
// Serves STORED data only (titles/summaries from tag strings, escaped text —
// never renderPost) to stay inside the 10ms public-path CPU budget. The
// per-tenant gen cache (middleware/cache.ts) keys on ONE pubkey's generation
// and cannot represent a cross-tenant page, so discover gets its OWN two
// protections (review fix — a Worker-GENERATED response is never stored in
// Cloudflare's edge cache just because it carries s-maxage; without an
// explicit Cache API put, EVERY request would run the D1 feed query, and
// page=50 costs ~1,000 rows_read against the free-tier daily budget):
//   1. a per-colo Cache API entry keyed on the CLAMPED page number alone
//      (bounded at DISCOVER_MAX_PAGE keys, immune to cache-buster params);
//   2. a per-IP rate limit (D1 rate_limits, zero KV writes) as the
//      cross-colo backstop — only cache MISSES spend it.
// No KV reads or writes on this path.

/** Cache API / shared-proxy TTL for the discover feed (seconds). */
export const DISCOVER_CACHE_SECONDS = 300;

/** Max cache-missing /discover requests per IP per window. */
export const DISCOVER_RATE_MAX = 60;
/** Discover rate-limit window (seconds). */
export const DISCOVER_RATE_WINDOW_SECONDS = 60;

/**
 * Cache API key for one discover page. Built from the CLAMPED page number —
 * never from the raw query string — so `?page=50&cb=<random>` cannot bust
 * the cache. Exported so tests can purge entries between mutations.
 */
export function discoverCacheKey(page: number): Request {
  return new Request(`https://cache.internal/discover?page=${page}`);
}

/**
 * Clamp a raw ?page= value to [1, DISCOVER_MAX_PAGE]. Garbage, negatives,
 * zero, and absurd depths all degrade to a valid page — never a 500, never
 * an unbounded OFFSET.
 */
export function clampPage(raw: string | undefined): number {
  if (!raw || !/^[0-9]{1,6}$/.test(raw)) return 1;
  const n = Number(raw);
  if (n < 1) return 1;
  return Math.min(n, DISCOVER_MAX_PAGE);
}

mainRoutes.get("/discover", async (c) => {
  const page = clampPage(c.req.query("page"));
  const mainHost = c.env.MAIN_HOST.toLowerCase();

  // (1) Per-colo Cache API layer — checked BEFORE the rate limit so cached
  // pages cost zero D1 (reads or rate-counter writes).
  const key = discoverCacheKey(page);
  try {
    const hit = await defaultCache().match(key);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set(CACHE_STATUS_HEADER, "hit");
      return res;
    }
  } catch {
    // Cache API unavailable — fall through and serve uncached.
  }

  // (2) Cross-colo backstop: per-IP fixed window in D1 (~1 row touched),
  // same pattern as /search below. Only cache misses reach the (far
  // heavier) feed query. Fails closed like every abuse cap in this file.
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const allowed = await rateLimitAllows(
    c.env,
    `discover:ip:${ip}`,
    DISCOVER_RATE_MAX,
    DISCOVER_RATE_WINDOW_SECONDS,
  );
  if (!allowed) {
    return c.html(
      DiscoverPage({
        items: [],
        page,
        hasNext: false,
        mainHost,
        error: "Too many requests — please wait a minute and try again.",
      }),
      429,
    );
  }

  const offset = (page - 1) * DISCOVER_PAGE_SIZE;
  // Fetch one extra row to detect whether an older page exists.
  const rows = await listRecentClaimedPosts(
    c.env,
    DISCOVER_PAGE_SIZE + 1,
    offset,
  );
  const hasNext = rows.length > DISCOVER_PAGE_SIZE && page < DISCOVER_MAX_PAGE;
  const res = await c.html(
    DiscoverPage({
      items: feedItems(rows.slice(0, DISCOVER_PAGE_SIZE), mainHost),
      page,
      hasNext,
      mainHost,
    }),
  );
  res.headers.set("Cache-Control", `public, s-maxage=${DISCOVER_CACHE_SECONDS}`);
  res.headers.set(CACHE_STATUS_HEADER, "miss");
  try {
    // Only 200s are cached; the 429 above never enters the cache.
    await defaultCache().put(key, res.clone());
  } catch {
    // Cache write failed — the response still goes out uncached.
  }
  return res;
});

// --- nostrbook.net/search — FTS5 search over mirrored posts (P6) --------------
// Public D1-query endpoint, so a light per-IP rate limit applies (D1
// rate_limits via the existing checkRateLimit — zero KV writes). The bound
// is generous for humans: 30 queries/minute/IP.

/** Max search queries per IP per window. */
export const SEARCH_RATE_MAX = 30;
/** Search rate-limit window (seconds). */
export const SEARCH_RATE_WINDOW_SECONDS = 60;

mainRoutes.get("/search", async (c) => {
  const mainHost = c.env.MAIN_HOST.toLowerCase();
  // Cap length up front; the sanitizer in searchPosts caps again.
  const query = (c.req.query("q") ?? "").slice(0, SEARCH_MAX_QUERY_CHARS);
  if (query.trim() === "") {
    // Bare form — no D1 query, no rate-limit spend.
    return c.html(SearchPage({ query: "", results: null, mainHost }));
  }
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const allowed = await rateLimitAllows(
    c.env,
    `search:ip:${ip}`,
    SEARCH_RATE_MAX,
    SEARCH_RATE_WINDOW_SECONDS,
  );
  if (!allowed) {
    return c.html(
      SearchPage({
        query,
        results: null,
        mainHost,
        error: "Too many searches — please wait a minute and try again.",
      }),
      429,
    );
  }
  const rows = await searchPosts(c.env, query);
  if (rows === null) {
    // Backend fault (never hostile input — the sanitizer's output is proven
    // valid MATCH). A 503 keeps outages visible in monitoring instead of
    // disguising them as "No posts matched" (review fix).
    return c.html(
      SearchPage({
        query,
        results: null,
        mainHost,
        error: "Search is temporarily unavailable — please try again shortly.",
      }),
      503,
    );
  }
  return c.html(
    SearchPage({ query, results: feedItems(rows, mainHost), mainHost }),
  );
});

// --- nostrbook.net/npub1… — on-demand blogs for UNCLAIMED pubkeys -------------
// Claimed pubkeys redirect to their subdomain; unclaimed ones get fetched
// from the relays and mirrored on demand (never more than NPUB_MIRROR_CAP
// event verifications per request), then rendered with the same tenant
// views under the base path /npub1…/. Later visits serve from D1 and
// progressively backfill older events via ctx.waitUntil.

/** Max event verifications (mirror attempts) per request (brief: 10). */
export const NPUB_MIRROR_CAP = 10;

/** Relay collection deadline for on-demand fetches (request path). */
const NPUB_FETCH_TIMEOUT_MS = 4_000;

/** Cooldown between relay round-trips per pubkey (Cache API marker TTL). */
const NPUB_COOLDOWN_SECONDS = 300;

// Abuse caps for the on-demand mirror (D1 rate_limits, fixed daily window).
// The per-pubkey cooldown alone is enumeration-bypassable: an attacker can
// mint unlimited distinct valid npubs and each first visit costs relay
// round-trips, D1 writes, and (via gen bumps) KV free-tier write budget.
/** Daily cap on relay mirror sessions across ALL unclaimed npubs. */
export const NPUB_MIRROR_GLOBAL_DAILY_CAP = 500;
/** Daily cap on relay mirror sessions per client IP. */
export const NPUB_MIRROR_IP_DAILY_CAP = 30;
/** rate_limits key for the global mirror budget. */
export const NPUB_MIRROR_GLOBAL_KEY = "npub-mirror:global";
const NPUB_MIRROR_WINDOW_SECONDS = 86_400;

/**
 * May this request start a relay mirror session? Checks the global budget
 * first (cheapest deny), then the per-IP budget. Fails CLOSED on D1 errors:
 * the page still renders from whatever is already mirrored.
 */
async function mirrorBudgetAllows(c: Context<DispatchEnv>): Promise<boolean> {
  try {
    const global_ = await checkRateLimit(
      c.env,
      NPUB_MIRROR_GLOBAL_KEY,
      NPUB_MIRROR_GLOBAL_DAILY_CAP,
      NPUB_MIRROR_WINDOW_SECONDS,
    );
    if (!global_.allowed) return false;
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const perIp = await checkRateLimit(
      c.env,
      `npub-mirror:ip:${ip}`,
      NPUB_MIRROR_IP_DAILY_CAP,
      NPUB_MIRROR_WINDOW_SECONDS,
    );
    return perIp.allowed;
  } catch (err) {
    console.error("npub mirror budget check failed:", err);
    return false;
  }
}

// npub payloads are fixed-size: "npub1" + 52 data chars + 6 checksum chars.
const NPUB_PARAM = "/:npub{npub1[a-z0-9]{58}}";

// --- npub VIEW limiter (P7 rate-limit review) ---------------------------------
// The mirror-session budgets above bound RELAY work, but the npub HTML/XML
// views themselves were unmetered D1 read paths: unlike blog subdomains
// (edge-cached per gen), every npub page view runs listPostsByPubkey
// (LIMIT 100 → up to ~100 rows_read) plus profile lookups, so one client
// could grind through the shared 5M rows_read/day free-tier budget. A per-IP
// fixed window (D1 rate_limits — zero KV writes, same pattern as
// discover/search) bounds it; the WAF zone rule (docs/ops.md) is the
// distributed backstop.

/** Max npub-view requests (any /npub1… path) per IP per window. */
export const NPUB_VIEW_RATE_MAX = 60;
/** npub-view rate-limit window (seconds). */
export const NPUB_VIEW_RATE_WINDOW_SECONDS = 60;

const npubViewLimiter: MiddlewareHandler<DispatchEnv> = async (c, next) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const allowed = await rateLimitAllows(
    c.env,
    `npub:ip:${ip}`,
    NPUB_VIEW_RATE_MAX,
    NPUB_VIEW_RATE_WINDOW_SECONDS,
  );
  if (!allowed) {
    return c.text("Too many requests — please wait a minute and try again.", 429);
  }
  return next();
};

// One registration covers BOTH the bare npub page and its sub-paths (feeds,
// post slugs): Hono's `/*` also matches the empty tail. Registering the bare
// pattern as well would run the limiter twice for home views.
mainRoutes.use(`${NPUB_PARAM}/*`, npubViewLimiter);

/**
 * Cache API marker that rate-limits relay round-trips per pubkey. Exported
 * so tests can clear it between visits.
 */
export function npubCooldownKey(pubkey: string): Request {
  return new Request(`https://cache.internal/npub-cooldown/${pubkey}`);
}

async function markCooldown(pubkey: string): Promise<void> {
  try {
    await defaultCache().put(
      npubCooldownKey(pubkey),
      new Response("1", {
        headers: { "Cache-Control": `s-maxage=${NPUB_COOLDOWN_SECONDS}` },
      }),
    );
  } catch {
    // marker is best-effort
  }
}

async function inCooldown(pubkey: string): Promise<boolean> {
  try {
    return (await defaultCache().match(npubCooldownKey(pubkey))) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Mirror up to `cap` events (newest first) that are not already stored.
 * Returns the number of verification credits spent (mirror attempts —
 * stale/invalid outcomes count too; the crypto ran).
 */
async function mirrorNewest(
  env: Env,
  pubkey: string,
  events: NostrEvent[],
  cap: number,
): Promise<number> {
  const candidates = events
    .filter(
      (ev) =>
        ev.pubkey === pubkey &&
        (ev.kind === 0 || ev.kind === 5 || ev.kind === 30023),
    )
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
  if (candidates.length === 0) return 0;
  const stored = await storedEventIds(
    env,
    candidates.map((ev) => ev.id),
  );
  let spent = 0;
  let storedAny = false;
  for (const ev of candidates) {
    if (spent >= cap) break;
    if (stored.has(ev.id)) continue;
    spent++;
    if ((await mirrorEvent(env, ev, { bumpGen: false })) === "stored") {
      storedAny = true;
    }
  }
  // One gen bump per mirror session (KV free tier: 1,000 writes/day), not
  // one per stored event.
  if (storedAny) await bumpGen(env, pubkey);
  return spent;
}

/** First visit (nothing mirrored yet): fetch newest events synchronously. */
async function syncFromRelays(env: Env, pubkey: string): Promise<void> {
  const events = await fetchEvents(
    relayList(env),
    { kinds: [0, 5, 30023], authors: [pubkey], limit: NPUB_MIRROR_CAP },
    NPUB_FETCH_TIMEOUT_MS,
  );
  await mirrorNewest(env, pubkey, events, NPUB_MIRROR_CAP);
}

/**
 * Background refresh + backfill: newest events first, then (with whatever
 * verification budget is left) events older than the oldest stored one.
 */
async function backfillFromRelays(env: Env, pubkey: string): Promise<void> {
  const relays = relayList(env);
  let cap = NPUB_MIRROR_CAP;
  const newest = await fetchEvents(
    relays,
    { kinds: [0, 5, 30023], authors: [pubkey], limit: NPUB_MIRROR_CAP },
    NPUB_FETCH_TIMEOUT_MS,
  );
  cap -= await mirrorNewest(env, pubkey, newest, cap);
  if (cap <= 0) return;
  const oldest = await oldestCreatedAt(env, pubkey);
  if (oldest === null) return;
  const older = await fetchEvents(
    relays,
    {
      kinds: [0, 5, 30023],
      authors: [pubkey],
      until: oldest,
      limit: NPUB_MIRROR_CAP,
    },
    NPUB_FETCH_TIMEOUT_MS,
  );
  await mirrorNewest(env, pubkey, older, cap);
}

/**
 * Ensure the pubkey has mirrored data: synchronous relay fetch on the very
 * first visit (nothing stored yet), background backfill afterwards — both
 * behind the per-pubkey cooldown marker AND the global/per-IP mirror budget
 * (checked second, so cooldown-suppressed visits never consume budget; a
 * budget-denied visit does NOT set the cooldown, so the pubkey mirrors
 * normally once budget frees up).
 */
async function ensureMirrored(
  c: Context<DispatchEnv>,
  pubkey: string,
  hasData: boolean,
): Promise<void> {
  if (await inCooldown(pubkey)) return;
  if (!(await mirrorBudgetAllows(c))) return;
  await markCooldown(pubkey);
  if (hasData) {
    c.executionCtx.waitUntil(backfillFromRelays(c.env, pubkey));
  } else {
    await syncFromRelays(c.env, pubkey);
  }
}

type NpubResolution =
  | { kind: "ok"; pubkey: string; npub: string }
  | { kind: "redirect"; handle: string }
  | { kind: "notfound" };

async function resolveNpub(c: Context<DispatchEnv>): Promise<NpubResolution> {
  const npub = c.req.param("npub") ?? "";
  let pubkey: string;
  try {
    pubkey = npubDecode(npub);
  } catch {
    return { kind: "notfound" };
  }
  const user = await getUserByPubkey(c.env, pubkey);
  if (user?.blocked) return { kind: "notfound" };
  if (user?.handle) return { kind: "redirect", handle: user.handle.toLowerCase() };
  return { kind: "ok", pubkey, npub };
}

/** Compact display form for headers/titles: npub1abcdefg…wxyz. */
function displayNpub(npub: string): string {
  return `${npub.slice(0, 13)}…${npub.slice(-6)}`;
}

function notFoundNpub(c: Context<DispatchEnv>) {
  return c.html(NotFoundPage({}), 404);
}

async function npubProfile(
  env: Env,
  pubkey: string,
): Promise<BlogProfile | null> {
  const row = await getProfileRow(env, pubkey);
  return row
    ? { name: row.name, picture: row.picture, about: row.about }
    : null;
}

mainRoutes.get(NPUB_PARAM, async (c) => {
  const r = await resolveNpub(c);
  if (r.kind === "notfound") return notFoundNpub(c);
  const mainHost = c.env.MAIN_HOST.toLowerCase();
  if (r.kind === "redirect") {
    return c.redirect(`https://${r.handle}.${mainHost}/`, 302);
  }

  let [profile, rows] = await Promise.all([
    npubProfile(c.env, r.pubkey),
    listPostsByPubkey(c.env, r.pubkey),
  ]);
  await ensureMirrored(c, r.pubkey, profile !== null || rows.length > 0);
  if (profile === null && rows.length === 0) {
    // First visit just mirrored synchronously — read again.
    [profile, rows] = await Promise.all([
      npubProfile(c.env, r.pubkey),
      listPostsByPubkey(c.env, r.pubkey),
    ]);
  }

  return c.html(
    BlogHome({
      handle: displayNpub(r.npub),
      profile,
      posts: rows.map(rowToEvent),
      themeCss: "",
      mainHost,
      basePath: `/${r.npub}`,
    }),
  );
});

mainRoutes.get(`${NPUB_PARAM}/rss.xml`, async (c) => {
  const r = await resolveNpub(c);
  if (r.kind === "notfound") return notFoundNpub(c);
  const mainHost = c.env.MAIN_HOST.toLowerCase();
  if (r.kind === "redirect") {
    return c.redirect(`https://${r.handle}.${mainHost}/rss.xml`, 302);
  }
  const [profile, rows] = await Promise.all([
    npubProfile(c.env, r.pubkey),
    listPostsByPubkey(c.env, r.pubkey),
  ]);
  const display = displayNpub(r.npub);
  const xml = rssFeed({
    title: profile?.name?.trim() || `@${display}`,
    description: profile?.about?.trim() || `Posts by @${display}`,
    baseUrl: `https://${mainHost}/${r.npub}`,
    handle: display,
    posts: rows.map(rowToEvent),
  });
  return c.body(xml, 200, {
    "Content-Type": "application/rss+xml; charset=utf-8",
  });
});

mainRoutes.get(`${NPUB_PARAM}/atom.xml`, async (c) => {
  const r = await resolveNpub(c);
  if (r.kind === "notfound") return notFoundNpub(c);
  const mainHost = c.env.MAIN_HOST.toLowerCase();
  if (r.kind === "redirect") {
    return c.redirect(`https://${r.handle}.${mainHost}/atom.xml`, 302);
  }
  const [profile, rows] = await Promise.all([
    npubProfile(c.env, r.pubkey),
    listPostsByPubkey(c.env, r.pubkey),
  ]);
  const display = displayNpub(r.npub);
  const xml = atomFeed({
    title: profile?.name?.trim() || `@${display}`,
    description: profile?.about?.trim() || `Posts by @${display}`,
    baseUrl: `https://${mainHost}/${r.npub}`,
    handle: display,
    posts: rows.map(rowToEvent),
  });
  return c.body(xml, 200, {
    "Content-Type": "application/atom+xml; charset=utf-8",
  });
});

mainRoutes.get(`${NPUB_PARAM}/:slug`, async (c) => {
  const r = await resolveNpub(c);
  if (r.kind === "notfound") return notFoundNpub(c);
  const mainHost = c.env.MAIN_HOST.toLowerCase();
  const slug = c.req.param("slug");
  if (r.kind === "redirect") {
    return c.redirect(
      `https://${r.handle}.${mainHost}/${encodeURIComponent(slug)}`,
      302,
    );
  }

  let row = await getPostRow(c.env, r.pubkey, slug);
  if (!row) {
    // Direct link to a not-yet-mirrored post: try an on-demand fetch (same
    // cooldown as the home route), then look once more.
    const [profile, rows] = await Promise.all([
      npubProfile(c.env, r.pubkey),
      listPostsByPubkey(c.env, r.pubkey, 1),
    ]);
    await ensureMirrored(c, r.pubkey, profile !== null || rows.length > 0);
    row = await getPostRow(c.env, r.pubkey, slug);
    if (!row) return notFoundNpub(c);
  }

  // Render-at-ingest contract (P2→P3 addendum): the request path never runs
  // renderPost. mirrorEvent always populates `rendered` for kind 30023; a
  // NULL here could only come from a manual insert or migration gap, and
  // falling back to synchronous markdown rendering would cost up to ~150ms
  // CPU on hostile input (15x the free-tier budget) — treat it as not found.
  const bodyHtml = row.rendered;
  if (bodyHtml === null) return notFoundNpub(c);

  const profile = await npubProfile(c.env, r.pubkey);
  return c.html(
    PostPage({
      handle: displayNpub(r.npub),
      profile,
      event: rowToEvent(row),
      bodyHtml,
      themeCss: "",
      mainHost,
      basePath: `/${r.npub}`,
    }),
  );
});
