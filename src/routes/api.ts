import { Hono } from "hono";
import type { DispatchEnv } from "../types";
import { getDTag, isNostrEvent } from "../nostr/event";
import { mirrorEvent } from "../services/mirror";
import { rateLimitAllows } from "../services/ratelimit";
import { getUserByPubkey } from "../services/users";

/**
 * JSON API (apex only). CSRF (Origin / Sec-Fetch-Site) and session
 * middleware run before this router (src/app.ts wires csrf → session →
 * routes for the whole main site, /api included), so a cross-origin POST
 * dies with 403 before reaching these handlers.
 */
export const apiRoutes = new Hono<DispatchEnv>();

/** Mirror publishes per pubkey per window (schnorr + render CPU bound). */
const MIRROR_MAX = 30;
const MIRROR_WINDOW_SECONDS = 5 * 60;

/**
 * Body cap, enforced from Content-Length before the JSON parse. isNostrEvent
 * re-caps the parsed fields (content ≤ 256Ki code units etc.); this bound
 * just refuses to buffer absurd bodies at all. A MISSING Content-Length is
 * itself rejected (a chunked / CL-less POST would otherwise pass a
 * `Number(undefined ?? "0") === 0` check and stream a platform-sized body
 * into c.req.json() before the field caps apply); browsers always send it for
 * a fetch with a string body, so editor.js is unaffected.
 */
const MAX_MIRROR_BODY_BYTES = 2_000_000;

/**
 * Absolute per-pubkey cap on the number of live kind-30023 slots one key may
 * create through the editor. The per-window rate limit (MIRROR_MAX) throttles
 * bursts but places NO ceiling on total stored posts — each distinct d-tag is
 * a new row, so ~8,600 new posts/day are otherwise reachable and D1 is shared
 * across all tenants (free tier ~5 GB). Edits (existing d-tag) and deletes are
 * always allowed; only NEW slots past the cap are refused. Generous for a real
 * blog; a bound, not a quota.
 */
export const MAX_POSTS_PER_PUBKEY = 1_000;

/**
 * POST /api/mirror — mirror a signed event for the LOGGED-IN key.
 *
 * The editor (public/js/editor.js) signs kind 30023 posts / kind 5 deletes
 * with the user's NIP-07 extension, broadcasts them to the user's relays
 * client-side (best-effort), and POSTs them here so the blog updates
 * immediately instead of waiting for the next cron refresh.
 *
 * Tenant isolation (P5 focus): ev.pubkey MUST equal the session pubkey —
 * a signed-in user can only ever publish or delete AS THEMSELVES, no matter
 * whose validly-signed events they replay into this endpoint. Kind 5 side
 * effects are additionally scoped to the signer's own rows inside
 * mirrorEvent (P3), so this check plus that scope give defense in depth.
 */
apiRoutes.post("/mirror", async (c) => {
  const sess = c.var.session;
  if (!sess) return c.json({ error: "authentication required" }, 401);

  const clHeader = c.req.header("content-length");
  const contentLength = Number(clHeader);
  if (
    clHeader === undefined ||
    clHeader === "" ||
    !Number.isFinite(contentLength) ||
    contentLength > MAX_MIRROR_BODY_BYTES
  ) {
    return c.json({ error: "missing or oversized body" }, 413);
  }

  // Rate limit before the expensive work (schnorr verify + render-at-ingest).
  if (
    !(await rateLimitAllows(
      c.env,
      `mirror:pk:${sess.pubkey}`,
      MIRROR_MAX,
      MIRROR_WINDOW_SECONDS,
    ))
  ) {
    return c.json({ error: "rate limited, try again later" }, 429);
  }

  // Blocked keys cannot publish or delete (mirrors the claim route). The
  // tenant middleware already 404s their blog, but without this the writes
  // still land (D1/FTS rows, gen bumps) and would resurface on unblock.
  const user = await getUserByPubkey(c.env, sess.pubkey);
  if (user?.blocked) {
    return c.json({ error: "account is blocked" }, 403);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  if (!isNostrEvent(body)) {
    return c.json({ error: "body must be a signed Nostr event" }, 400);
  }
  const ev = body;

  // Tenant isolation: only the session's own key may be published. 403 —
  // the event may be perfectly valid, it just is not YOURS.
  if (ev.pubkey !== sess.pubkey) {
    return c.json({ error: "event pubkey does not match the signed-in key" }, 403);
  }

  // Only long-form posts and deletes flow through the editor; profiles and
  // everything else arrive via the relay sync paths (cron refresh).
  if (ev.kind !== 30023 && ev.kind !== 5) {
    return c.json(
      { error: "only kind 30023 (post) and kind 5 (delete) are accepted" },
      400,
    );
  }

  // Absolute per-pubkey cap: a NEW 30023 slot (a d-tag not already stored) is
  // refused once the key holds MAX_POSTS_PER_PUBKEY live posts. Edits (the
  // d-tag already exists) and deletes are never blocked. This is the editor
  // path only — cron/npub ingestion of a user's real backlog goes through
  // mirrorEvent directly and is not capped here.
  if (ev.kind === 30023) {
    const dTag = getDTag(ev);
    const existing = await c.env.DB.prepare(
      "SELECT 1 FROM events WHERE pubkey = ? AND kind = 30023 AND d_tag = ?",
    )
      .bind(ev.pubkey, dTag)
      .first();
    if (!existing) {
      const row = await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE pubkey = ? AND kind = 30023 AND deleted = 0",
      )
        .bind(ev.pubkey)
        .first<{ n: number }>();
      if ((row?.n ?? 0) >= MAX_POSTS_PER_PUBKEY) {
        return c.json(
          { error: `post limit reached (max ${MAX_POSTS_PER_PUBKEY})` },
          403,
        );
      }
    }
  }

  const result = await mirrorEvent(c.env, ev);
  return c.json({ result }, result === "invalid" ? 422 : 200);
});
