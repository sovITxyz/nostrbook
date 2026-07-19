/**
 * Scheduled refresh (cron every 15 min): for each claimed, non-blocked user,
 * fetch kinds 0+5+30023 from the configured relays since the last watermark
 * and mirror them — capped at REFRESH_VERIFY_CAP new-event verifications per
 * user per run (schnorr + render CPU stays bounded), resuming next tick via
 * a `sync.since` watermark kept in users.settings (D1 — the KV free-tier
 * write budget is reserved for sessions and gen bumps).
 *
 * Watermark rules (each one closes a data-loss / poisoning hole):
 *   - only VERIFIED events advance it — a forged event from a hostile relay
 *     must not drag `since` into the future and strand the user's real posts;
 *   - far-future created_at values are skipped entirely (clock skew/forgery);
 *   - it never advances over an UNCLOSED relay window: NIP-01 `limit` keeps
 *     the newest matches, so a full page may have silently dropped older
 *     events — `until`-paging walks backward until a non-full page proves
 *     the window is complete.
 */
import { readBlogSettings, type User } from "../services/users";
import { fetchEvents } from "../nostr/relay";
import { bumpGen, mirrorEvent } from "../services/mirror";
import { storedEventIds } from "../services/events";
import { refreshZapsForUser } from "../services/zaps";
import type { NostrEvent } from "../nostr/event";
import { isSelfRelayHost } from "../relay/url";

/** Max NEW events verified+mirrored per user per cron run (contract: ~5). */
export const REFRESH_VERIFY_CAP = 5;

/** Relay collection deadline per user (cron wall-clock budget is generous). */
export const REFRESH_TIMEOUT_MS = 8_000;

/** Relay filter limit — a few runs' worth of backlog per fetch. */
const REFRESH_FETCH_LIMIT = 60;

/** Max relay pages per user per run (backward `until`-paging on full pages). */
const REFRESH_MAX_PAGES = 3;

/**
 * Ignore events whose created_at is further in the future than this. A
 * hostile relay (or a badly skewed client clock) publishing a far-future
 * event must never advance the sync watermark — every later `since` filter
 * would skip the user's real events forever.
 */
export const MAX_FUTURE_SKEW_SECONDS = 900;

/** Parse the RELAYS env var (comma-separated ws(s) URLs). */
export function relayList(env: Env): string[] {
  return env.RELAYS.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read the sync watermark from a users.settings JSON blob (0 when unset). */
export function readSince(settings: string): number {
  try {
    const parsed: unknown = JSON.parse(settings);
    if (parsed !== null && typeof parsed === "object") {
      const sync = (parsed as Record<string, unknown>).sync;
      if (sync !== null && typeof sync === "object") {
        const since = (sync as Record<string, unknown>).since;
        if (
          typeof since === "number" &&
          Number.isFinite(since) &&
          since >= 0
        ) {
          return Math.floor(since);
        }
      }
    }
  } catch {
    // malformed settings → start from 0
  }
  return 0;
}

/**
 * Persist the watermark. json_set touches ONLY $.sync.since inside the
 * current stored blob, so a concurrent settings write (e.g. a future
 * dashboard save of theme CSS) is never clobbered by a stale
 * read-modify-write of the whole column. Malformed/non-object blobs (and a
 * non-object $.sync, which json_set would silently no-op on) are rebuilt.
 */
async function writeSince(
  env: Env,
  pubkey: string,
  since: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE users SET settings = json_set(
       CASE
         WHEN json_valid(settings) AND json_type(settings) = 'object' THEN
           CASE WHEN json_type(settings, '$.sync') = 'object' THEN settings
                ELSE json_set(settings, '$.sync', json('{}')) END
         ELSE '{}'
       END,
       '$.sync.since', ?
     ) WHERE pubkey = ?`,
  )
    .bind(since, pubkey)
    .run();
}

/**
 * Collect the user's backlog since the watermark. NIP-01 `limit` keeps the
 * NEWEST matches, so a full page may have dropped events OLDER than the
 * oldest returned one; page backward with `until` (inclusive — boundary
 * events dedupe by id) until a non-full page closes the window or the page
 * budget runs out. `windowClosed === false` means relays may still hold
 * unseen events inside [since, now] and the watermark must not advance.
 *
 * Truncation detection uses the RAW batch size: fetchEvents dedupes across
 * relays, so a batch smaller than the limit proves no single relay hit its
 * `limit` cutoff.
 */
async function collectBacklog(
  relays: string[],
  user: User,
  since: number,
): Promise<{ events: NostrEvent[]; windowClosed: boolean }> {
  const byId = new Map<string, NostrEvent>();
  let windowClosed = false;
  let until: number | null = null;

  for (let page = 0; page < REFRESH_MAX_PAGES; page++) {
    const filter: Record<string, unknown> = {
      kinds: [0, 5, 30023],
      authors: [user.pubkey],
      limit: REFRESH_FETCH_LIMIT,
    };
    if (since > 0) filter.since = since;
    if (until !== null) filter.until = until;

    const batch = await fetchEvents(relays, filter, REFRESH_TIMEOUT_MS);
    const mine = batch.filter(
      (ev) =>
        ev.pubkey === user.pubkey &&
        (ev.kind === 0 || ev.kind === 5 || ev.kind === 30023),
    );
    for (const ev of mine) byId.set(ev.id, ev);

    if (batch.length < REFRESH_FETCH_LIMIT) {
      windowClosed = true;
      break;
    }
    if (mine.length === 0) break; // full page of junk — treat as truncated
    const oldest = Math.min(...mine.map((ev) => ev.created_at));
    if (until !== null && oldest >= until) break; // no backward progress
    until = oldest;
  }

  return { events: [...byId.values()], windowClosed };
}

/**
 * Refresh one user. Events are processed OLDEST FIRST so the watermark is a
 * true resume point: when the verification cap trips mid-batch, everything
 * up to the watermark is mirrored and the rest is refetched next tick
 * (`since` is inclusive; the boundary event comes back already-stored and
 * costs no verification).
 */
async function refreshUser(
  env: Env,
  baseRelays: string[],
  user: User,
): Promise<void> {
  // Sync from the user's configured relays too — settings.relays is documented
  // as "editor-side broadcast + sync", and a user whose posts live only on
  // their own relays would otherwise never be mirrored by cron. Merge their
  // list ahead of the service defaults (deduped).
  const configured = readBlogSettings(user.settings).relays;
  // Filter out our own first-party relay AFTER the merge (users may paste
  // wss://nbread.lol/relay into their settings): a Worker-to-own-zone ws
  // subrequest won't reliably re-enter this Worker, and the relay shares the
  // same D1 events store anyway — reading ourselves is a no-op at best.
  const relays = [...new Set([...configured, ...baseRelays])].filter(
    (url) => !isSelfRelayHost(url, env),
  );
  const since = readSince(user.settings);
  const { events: collected, windowClosed } = await collectBacklog(
    relays,
    user,
    since,
  );
  const events = collected.sort(
    (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1),
  );
  if (events.length === 0) return;

  const stored = await storedEventIds(
    env,
    events.map((ev) => ev.id),
  );
  const maxPlausible =
    Math.floor(Date.now() / 1000) + MAX_FUTURE_SKEW_SECONDS;

  let credits = REFRESH_VERIFY_CAP;
  let watermark = since;
  let storedAny = false;
  for (const ev of events) {
    // Far-future created_at (forged or badly skewed clock): skip without
    // spending a verification credit and WITHOUT advancing the watermark.
    if (ev.created_at > maxPlausible) continue;
    if (stored.has(ev.id)) {
      // Verified when it was stored — safe to advance past it.
      if (ev.created_at > watermark) watermark = ev.created_at;
      continue;
    }
    if (credits === 0) break; // resume from `watermark` next tick
    credits--;
    const result = await mirrorEvent(env, ev, { bumpGen: false });
    if (result === "invalid") continue; // unverified events never advance the watermark
    if (result === "stored") storedAny = true;
    if (ev.created_at > watermark) watermark = ev.created_at;
  }
  // One gen bump per run (KV free tier: 1,000 writes/day), not one per event.
  if (storedAny) await bumpGen(env, user.pubkey);

  // Defense-in-depth clamp: even a verified event cannot push the persisted
  // watermark meaningfully past "now".
  watermark = Math.min(watermark, maxPlausible);

  // An unclosed window means relays truncated events we have not seen yet;
  // advancing the watermark would skip them permanently. Keep it put — the
  // already-mirrored ids cost no credits on refetch next tick.
  if (windowClosed && watermark !== since) {
    await writeSince(env, user.pubkey, watermark);
  }
}

/** Entry point for the scheduled handler (src/index.ts). */
export async function runRefresh(
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const users = await env.DB.prepare(
    "SELECT * FROM users WHERE handle IS NOT NULL AND blocked = 0",
  ).all<User>();
  const relays = relayList(env);
  if (relays.length === 0) return;

  for (const user of users.results) {
    try {
      await refreshUser(env, relays, user);
    } catch (err) {
      // One user's relay trouble must not sink the whole run.
      console.error(`refresh failed for ${user.pubkey}:`, err);
    }
    // Zap receipt pass (#12): independent try — a broken LNURL endpoint or
    // relay must not cost the user their post sync (or vice versa).
    try {
      await refreshZapsForUser(env, relays, user);
    } catch (err) {
      console.error(`zap refresh failed for ${user.pubkey}:`, err);
    }
  }
}
