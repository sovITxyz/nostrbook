import { Hono } from "hono";
import type { Context } from "hono";
import type { DispatchEnv } from "../types";
import { npubDecode, npubEncode } from "../nostr/nip19";
import { getUserByHandle, HANDLE_REGEX } from "../services/users";
import { bumpGen } from "../services/mirror";
import { rateLimitAllows } from "../services/ratelimit";
import { AdminPage, type BlockedEntry } from "../views/main/admin";

/**
 * Abuse-blocklist admin surface (P7). Apex only, mounted at /admin AFTER the
 * csrf + session middleware in src/app.ts, so every unsafe method already
 * carries same-origin proof before these handlers run.
 *
 * Gate (the use("*") below, applied to every route + method):
 *   1. ADMIN_PUBKEY unset/empty/malformed → 404. The surface does not exist
 *      unless the operator deliberately provisions the secret — fail closed,
 *      and a malformed value can never accidentally match anyone.
 *   2. No session, or session.pubkey !== ADMIN_PUBKEY → 404 (indistinguishable
 *      from "disabled": no probing signal for non-admins).
 *
 * Blocking sets users.blocked = 1, which the rest of the app ALREADY
 * consumes everywhere (verified by test/integration/admin.spec.ts):
 *   - tenant middleware 404s the blog subdomain (checked before the edge
 *     cache, so even warm caches stop serving instantly);
 *   - resolveNpub 404s the apex /npub1… views;
 *   - discover + search JOIN on blocked = 0 (cached /discover pages age out
 *     within DISCOVER_CACHE_SECONDS = 300s);
 *   - POST /api/mirror, /dashboard/settings, /dashboard/claim refuse (403),
 *     and so does POST /dashboard/preview — the one endpoint allowed to run
 *     renderPost on the request path (blocked keys must not spend that CPU);
 *   - NIP-05: /.well-known/nostr.json returns {"names":{}} for blocked
 *     handles — DECIDED policy: blocked users are dropped from nostr.json
 *     entirely, so the platform stops vouching for the identity the moment
 *     the block lands (docs/ops.md).
 * On top of that, block/unblock bump the user's KV gen so already-cached
 * blog pages die immediately (gen bumps are an existing KV write class; the
 * per-admin-action rate limit bounds the spend).
 */
export const adminRoutes = new Hono<DispatchEnv>();

/** Max admin actions (block/unblock POSTs) per admin key per window. */
export const ADMIN_ACTION_MAX = 30;
/** Admin action rate-limit window (seconds). */
export const ADMIN_ACTION_WINDOW_SECONDS = 5 * 60;

const PUBKEY_HEX = /^[0-9a-f]{64}$/;

/**
 * Resolve the configured admin pubkey to lowercase hex, accepting hex or
 * npub1… forms. Returns null (surface disabled) when unset, empty, or
 * malformed — a typo in the secret must fail closed, never open.
 */
export function adminPubkeyOf(env: Env): string | null {
  const raw = (env.ADMIN_PUBKEY ?? "").trim();
  if (raw === "") return null;
  if (raw.startsWith("npub1")) {
    try {
      return npubDecode(raw);
    } catch {
      return null;
    }
  }
  const hex = raw.toLowerCase();
  return PUBKEY_HEX.test(hex) ? hex : null;
}

// The gate: disabled surface and non-admin callers are both a plain 404.
adminRoutes.use("*", async (c, next) => {
  const admin = adminPubkeyOf(c.env);
  if (admin === null) return c.text("Not found", 404);
  const sess = c.var.session;
  if (!sess || sess.pubkey !== admin) return c.text("Not found", 404);
  await next();
});

async function renderAdmin(
  c: Context<DispatchEnv>,
  error: string | null,
  status: 200 | 400 | 429,
  notice: string | null = null,
) {
  const rows = await c.env.DB.prepare(
    "SELECT pubkey, handle FROM users WHERE blocked = 1 ORDER BY handle IS NULL, handle LIMIT 200",
  ).all<{ pubkey: string; handle: string | null }>();
  const blocked: BlockedEntry[] = rows.results.map((row) => ({
    npub: npubEncode(row.pubkey),
    handle: row.handle,
  }));
  return c.html(
    AdminPage({
      mainHost: c.env.MAIN_HOST.toLowerCase(),
      error,
      notice,
      blocked,
    }),
    status,
  );
}

/** Notices keyed by the ?ok= redirect param (never reflect raw input). */
const NOTICES: Record<string, string> = {
  blocked: "User blocked.",
  unblocked: "User unblocked.",
};

adminRoutes.get("/", async (c) => {
  const ok = c.req.query("ok") ?? "";
  return renderAdmin(c, null, 200, NOTICES[ok] ?? null);
});

/**
 * Resolve a block/unblock target — handle, npub1…, or hex pubkey — to a
 * pubkey. Handles resolve through the existing COLLATE NOCASE lookup; npubs
 * and hex work for keys that never claimed (or whose handle is unknown), so
 * hostile unclaimed npub blogs can be blocked pre-emptively.
 */
async function resolveTarget(
  env: Env,
  raw: string,
): Promise<{ pubkey: string } | { error: string }> {
  const target = raw.trim();
  if (target === "") return { error: "Enter a handle, npub, or hex pubkey." };
  if (target.startsWith("npub1")) {
    try {
      return { pubkey: npubDecode(target) };
    } catch {
      // Not a decodable npub — but HANDLE_REGEX admits short handles that
      // START with "npub1" (e.g. "npub1spam"; ≤31 chars, real npubs are 63
      // and can never match), and a hostile user can deliberately claim one
      // so that pasting their handle here misroutes to a decode error during
      // an abuse incident (P7 review fix). Fall through to the handle lookup
      // whenever the input is handle-shaped; only true npub shapes keep the
      // decode error.
      if (!HANDLE_REGEX.test(target)) {
        return { error: "That npub does not decode." };
      }
    }
  }
  if (PUBKEY_HEX.test(target.toLowerCase())) {
    return { pubkey: target.toLowerCase() };
  }
  const user = await getUserByHandle(env, target);
  if (!user) return { error: "No user with that handle." };
  return { pubkey: user.pubkey };
}

/** Shared prologue for the POST actions: rate limit, then target resolution. */
async function actionTarget(
  c: Context<DispatchEnv>,
): Promise<{ pubkey: string } | { response: Response }> {
  // c.var.session is non-null here (the gate ran); keyed per admin key.
  const sess = c.var.session!;
  if (
    !(await rateLimitAllows(
      c.env,
      `admin:pk:${sess.pubkey}`,
      ADMIN_ACTION_MAX,
      ADMIN_ACTION_WINDOW_SECONDS,
    ))
  ) {
    return {
      response: await renderAdmin(
        c,
        "Too many admin actions — try again shortly.",
        429,
      ),
    };
  }
  const body = await c.req.parseBody();
  const raw = typeof body.target === "string" ? body.target : "";
  const resolved = await resolveTarget(c.env, raw);
  if ("error" in resolved) {
    return { response: await renderAdmin(c, resolved.error, 400) };
  }
  return resolved;
}

adminRoutes.post("/block", async (c) => {
  const r = await actionTarget(c);
  if ("response" in r) return r.response;

  // Foot-gun guard: the admin key cannot block itself (a blocked admin could
  // still reach /admin — the gate checks identity, not blocked — but there
  // is no legitimate reason, so refuse outright).
  if (r.pubkey === adminPubkeyOf(c.env)) {
    return renderAdmin(c, "Refusing to block the admin key.", 400);
  }

  // Upsert so UNCLAIMED keys (no users row yet) can be blocked pre-emptively:
  // the row is created blocked with a NULL handle, which also makes any later
  // /dashboard/claim by that key refuse (the claim route checks blocked).
  await c.env.DB.prepare(
    `INSERT INTO users (pubkey, claimed_at, blocked) VALUES (?1, ?2, 1)
     ON CONFLICT(pubkey) DO UPDATE SET blocked = 1`,
  )
    .bind(r.pubkey, new Date().toISOString())
    .run();
  // Kill already-cached blog pages: the gen is part of every cache key for
  // this blog, so a bump strands them all (defense in depth — the tenant
  // middleware's blocked check already precedes cache serving).
  await bumpGen(c.env, r.pubkey);
  return c.redirect("/admin?ok=blocked", 303);
});

adminRoutes.post("/unblock", async (c) => {
  const r = await actionTarget(c);
  if ("response" in r) return r.response;

  // Plain UPDATE: unblocking a never-seen key is a no-op, not an insert.
  await c.env.DB.prepare(
    "UPDATE users SET blocked = 0 WHERE pubkey = ?1",
  )
    .bind(r.pubkey)
    .run();
  // Fresh gen so the first post-unblock render is never a stale pre-block
  // cache entry.
  await bumpGen(c.env, r.pubkey);
  return c.redirect("/admin?ok=unblocked", 303);
});
