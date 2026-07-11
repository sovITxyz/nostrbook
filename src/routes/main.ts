import { Hono } from "hono";
import type { Context } from "hono";
import type { DispatchEnv } from "../types";
import { MainHome } from "../views/main/home";
import { npubDecode } from "../nostr/nip19";
import { fetchEvents } from "../nostr/relay";
import type { NostrEvent } from "../nostr/event";
import { getUserByPubkey } from "../services/users";
import { bumpGen, mirrorEvent } from "../services/mirror";
import { checkRateLimit } from "../services/ratelimit";
import {
  getPost as getPostRow,
  listPostsByPubkey,
  oldestCreatedAt,
  rowToEvent,
  storedEventIds,
} from "../services/events";
import { getProfile as getProfileRow } from "../services/profiles";
import { relayList } from "../cron/refresh";
import { defaultCache } from "../middleware/cache";
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
