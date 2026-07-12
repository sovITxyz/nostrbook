import { Hono } from "hono";
import type { Context } from "hono";
import type { DispatchEnv } from "../types";
import { npubEncode } from "../nostr/nip19";
import {
  ClaimError,
  claimHandle,
  getUserByPubkey,
  HANDLE_REGEX,
  readBlogSettings,
  updateBlogSettings,
  type User,
} from "../services/users";
import { rateLimitAllows } from "../services/ratelimit";
import { getPost, listPostsByPubkey, rowToEvent } from "../services/events";
import { bumpGen } from "../services/mirror";
import { renderPost } from "../markdown";
import { sanitizeCss, MAX_THEME_CSS_LENGTH } from "../markdown/css-sanitize";
import { firstTagValue, isoDate, postMeta } from "../markdown/nip23";
import { relayList } from "../cron/refresh";
import { DashboardPage, type DashboardPost } from "../views/main/dashboard";
import { EditorPage } from "../views/main/editor";

/**
 * Dashboard (apex only, session required): handle claim (P4), the signed-in
 * user's post list, blog settings, the editor pages, and the server-rendered
 * markdown preview (P5). All POSTs are covered by the csrf middleware wired
 * before this router in src/app.ts.
 */
export const dashboardRoutes = new Hono<DispatchEnv>();

/** Claim rate limit: 3 per hour per IP (D1 rate_limits, fixed window). */
const CLAIM_MAX = 3;
const CLAIM_WINDOW_SECONDS = 60 * 60;

/**
 * Preview rate limit per pubkey. Preview runs renderPost on the REQUEST path
 * (hostile 32 KiB markdown ≈ 150ms CPU — see MAX_MARKDOWN_LENGTH), which the
 * public tenant routes are forbidden to do; for the authed editor it is
 * unavoidable, so it is budgeted instead.
 */
const PREVIEW_MAX = 60;
const PREVIEW_WINDOW_SECONDS = 5 * 60;

/** Body cap for the preview endpoint (Content-Length pre-check). */
const MAX_PREVIEW_BODY_BYTES = 400_000;

/**
 * Settings-save rate limit per pubkey. Sessions are permissionless (anyone can
 * generate a keypair and sign a login), and every save bumps the KV gen and
 * writes D1; without a cap one authenticated key could loop the endpoint and
 * exhaust the platform-wide free-tier KV write budget (1,000/day), breaking
 * cache invalidation AND new-login session creation for ALL tenants.
 */
export const SETTINGS_MAX = 20;
const SETTINGS_WINDOW_SECONDS = 5 * 60;

/** Cap on the stored about text (settings form). */
const MAX_ABOUT_LENGTH = 1_000;

/** Caps on the relay list (settings form). */
export const MAX_RELAYS = 10;
const MAX_RELAY_URL_LENGTH = 200;

// --- Turnstile ---------------------------------------------------------------

export const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Injectable verifier seam: tests swap the network call for a fake
 * (vitest-pool-workers runs the worker in the test isolate, so module state
 * is shared — same pattern as the relay socket factory). Production always
 * uses siteverifyTurnstile below.
 */
export type TurnstileVerifier = (
  env: Env,
  token: string,
  remoteIp?: string,
) => Promise<boolean>;

/**
 * Real Cloudflare siteverify call. Fails closed on network errors, non-2xx
 * responses, and non-JSON bodies. With the official test secret
 * `1x0000000000000000000000000000000AA` (.dev.vars.example) siteverify
 * always reports success — used for local dev; tests inject a fake instead
 * (no network in tests).
 */
export const siteverifyTurnstile: TurnstileVerifier = async (
  env,
  token,
  remoteIp,
) => {
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      body,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: unknown };
    return data.success === true;
  } catch (err) {
    console.error("turnstile siteverify failed:", err);
    return false;
  }
};

let turnstileVerifier: TurnstileVerifier = siteverifyTurnstile;

/** TEST ONLY: swap the Turnstile verifier. Pass null to restore the real one. */
export function setTurnstileVerifierForTests(
  fn: TurnstileVerifier | null,
): void {
  turnstileVerifier = fn ?? siteverifyTurnstile;
}

// --- Helpers -------------------------------------------------------------------

function clientIp(c: Context<DispatchEnv>): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

/**
 * Relays the editor should broadcast to: the user's configured list, falling
 * back to the service defaults (RELAYS env var) when none are set.
 */
function editorRelays(env: Env, user: User | null): string[] {
  const configured = readBlogSettings(user?.settings ?? "{}").relays;
  return configured.length > 0 ? configured : relayList(env);
}

/**
 * Parse + validate the relay-list textarea (one wss:// URL per line; commas
 * tolerated). Returns null when ANY entry is invalid — settings saves are
 * all-or-nothing so a typo never silently drops a relay.
 */
export function parseRelayList(input: string): string[] | null {
  const entries = input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length > MAX_RELAYS) return null;
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.length > MAX_RELAY_URL_LENGTH) return null;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return null;
    }
    // wss:// only: the editor opens these from a https page (mixed-content
    // rules would block ws://) and the cron sync treats them as trusted-ish
    // transport. Credentials in the URL are rejected outright.
    if (url.protocol !== "wss:" || url.hostname.length === 0) return null;
    if (url.username !== "" || url.password !== "") return null;
    out.push(url.toString());
  }
  return [...new Set(out)];
}

async function renderDashboard(
  c: Context<DispatchEnv>,
  pubkey: string,
  error: string | null,
  status: 200 | 400 | 403 | 409 | 429,
  saved = false,
) {
  const user = await getUserByPubkey(c.env, pubkey);
  const rows = await listPostsByPubkey(c.env, pubkey);
  const posts: DashboardPost[] = rows.map((row) => {
    const meta = postMeta(rowToEvent(row));
    return { slug: row.d_tag, title: meta.title, date: isoDate(meta.published_at) };
  });
  return c.html(
    DashboardPage({
      npub: npubEncode(pubkey),
      handle: user?.handle ?? null,
      mainHost: c.env.MAIN_HOST.toLowerCase(),
      turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
      error,
      saved,
      posts,
      settings: readBlogSettings(user?.settings ?? "{}"),
    }),
    status,
  );
}

// --- Routes --------------------------------------------------------------------

dashboardRoutes.get("/", async (c) => {
  const sess = c.var.session;
  if (!sess) return c.redirect("/login", 302);
  return renderDashboard(
    c,
    sess.pubkey,
    null,
    200,
    c.req.query("saved") === "1",
  );
});

const CLAIM_ERROR_RESPONSES: Record<
  ClaimError["code"],
  { status: 400 | 409; message: string }
> = {
  invalid: {
    status: 400,
    message:
      "Handles are 2–31 characters: lowercase letters, digits, and hyphens (must start and end with a letter or digit).",
  },
  reserved: { status: 400, message: "That handle is reserved." },
  taken: { status: 409, message: "That handle is already taken." },
  already_claimed: {
    status: 409,
    message: "Your key already has a handle — one handle per key.",
  },
};

dashboardRoutes.post("/claim", async (c) => {
  const sess = c.var.session;
  if (!sess) return c.json({ error: "authentication required" }, 401);

  // Rate limit before anything costly (every attempt counts, denied included).
  const ip = clientIp(c);
  if (
    !(await rateLimitAllows(
      c.env,
      `claim:ip:${ip}`,
      CLAIM_MAX,
      CLAIM_WINDOW_SECONDS,
    ))
  ) {
    return renderDashboard(
      c,
      sess.pubkey,
      "Too many claim attempts — try again later.",
      429,
    );
  }

  const user = await getUserByPubkey(c.env, sess.pubkey);
  if (user?.blocked) {
    return renderDashboard(c, sess.pubkey, "This account is blocked.", 403);
  }

  const body = await c.req.parseBody();
  const handle = typeof body.handle === "string" ? body.handle.trim() : "";
  const turnstileToken =
    typeof body["cf-turnstile-response"] === "string"
      ? body["cf-turnstile-response"]
      : "";

  // Cheap shape check before the Turnstile subrequest.
  if (!HANDLE_REGEX.test(handle)) {
    return renderDashboard(
      c,
      sess.pubkey,
      CLAIM_ERROR_RESPONSES.invalid.message,
      400,
    );
  }

  if (
    turnstileToken === "" ||
    !(await turnstileVerifier(
      c.env,
      turnstileToken,
      c.req.header("CF-Connecting-IP"),
    ))
  ) {
    return renderDashboard(
      c,
      sess.pubkey,
      "Human verification failed — please retry the challenge.",
      403,
    );
  }

  try {
    await claimHandle(c.env, sess.pubkey, handle);
  } catch (err) {
    if (err instanceof ClaimError) {
      const { status, message } = CLAIM_ERROR_RESPONSES[err.code];
      return renderDashboard(c, sess.pubkey, message, status);
    }
    throw err;
  }
  return c.redirect("/dashboard", 303);
});

// --- POST /dashboard/settings — theme CSS, about, relay list --------------------
dashboardRoutes.post("/settings", async (c) => {
  const sess = c.var.session;
  if (!sess) return c.json({ error: "authentication required" }, 401);

  // Rate limit BEFORE any KV/D1 write (see SETTINGS_MAX): a permissionless
  // session must not be able to burn the platform-wide KV write budget.
  if (
    !(await rateLimitAllows(
      c.env,
      `settings:pk:${sess.pubkey}`,
      SETTINGS_MAX,
      SETTINGS_WINDOW_SECONDS,
    ))
  ) {
    return renderDashboard(
      c,
      sess.pubkey,
      "Too many settings saves — try again later.",
      429,
    );
  }

  // Blocked keys cannot persist settings (mirrors the claim + mirror routes).
  const currentUser = await getUserByPubkey(c.env, sess.pubkey);
  if (currentUser?.blocked) {
    return renderDashboard(c, sess.pubkey, "This account is blocked.", 403);
  }

  const body = await c.req.parseBody();
  const cssRaw = typeof body.css === "string" ? body.css : "";
  const aboutRaw = typeof body.about === "string" ? body.about : "";
  const relaysRaw = typeof body.relays === "string" ? body.relays : "";

  if (cssRaw.length > MAX_THEME_CSS_LENGTH) {
    return renderDashboard(
      c,
      sess.pubkey,
      `Theme CSS is too large (max ${MAX_THEME_CSS_LENGTH} characters).`,
      400,
    );
  }

  const relays = parseRelayList(relaysRaw);
  if (relays === null) {
    return renderDashboard(
      c,
      sess.pubkey,
      `Relay list must be at most ${MAX_RELAYS} wss:// URLs, one per line.`,
      400,
    );
  }

  // Sanitize the theme CSS at WRITE time (P2 addendum: "P5 should
  // additionally sanitize CSS at settings-save time"). The blog layout
  // re-sanitizes at render as the last gate — the stored value must already
  // be declawed so nothing hostile ever round-trips through D1.
  const css = sanitizeCss(cssRaw);
  const about = aboutRaw
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, MAX_ABOUT_LENGTH);

  await updateBlogSettings(c.env, sess.pubkey, { css, about, relays });
  // Only css/about are rendered on the (edge-cached) blog, so only a real
  // change to either warrants a KV gen bump — a no-op save (or a relays-only
  // change) costs zero KV writes. Bumps are the scarce free-tier resource.
  const prev = readBlogSettings(currentUser?.settings ?? "{}");
  if (prev.css !== css || prev.about !== about) {
    await bumpGen(c.env, sess.pubkey);
  }
  return c.redirect("/dashboard?saved=1", 303);
});

// --- Editor pages ----------------------------------------------------------------

dashboardRoutes.get("/posts/new", async (c) => {
  const sess = c.var.session;
  if (!sess) return c.redirect("/login", 302);
  const user = await getUserByPubkey(c.env, sess.pubkey);
  return c.html(
    EditorPage({
      mode: "new",
      slug: "",
      title: "",
      summary: "",
      content: "",
      publishedAt: null,
      prevCreatedAt: null,
      eventId: null,
      pubkey: sess.pubkey,
      relays: editorRelays(c.env, user),
      handle: user?.handle ?? null,
      mainHost: c.env.MAIN_HOST.toLowerCase(),
    }),
  );
});

// Edit page for an existing post. The slug (d-tag) is a QUERY parameter, not a
// path segment, so hostile / colliding d-tags — "new" (which the editor's own
// slugify mints from the title "New", and relay-mirrored posts may carry), ".",
// ".." — address the correct post instead of being shadowed by /posts/new or
// path-normalized by the browser.
dashboardRoutes.get("/editor", async (c) => {
  const sess = c.var.session;
  if (!sess) return c.redirect("/login", 302);
  const slug = c.req.query("slug") ?? "";
  if (slug === "") return c.text("post not found", 404);
  // Own posts only: the lookup is keyed by the SESSION pubkey, so /dashboard
  // can never open (or later delete) someone else's post.
  const row = await getPost(c.env, sess.pubkey, slug);
  if (!row) return c.text("post not found", 404);
  const ev = rowToEvent(row);
  const meta = postMeta(ev);
  const user = await getUserByPubkey(c.env, sess.pubkey);
  return c.html(
    EditorPage({
      mode: "edit",
      slug: row.d_tag,
      title: firstTagValue(ev, "title") ?? meta.title,
      summary: firstTagValue(ev, "summary") ?? "",
      content: row.content,
      publishedAt: meta.published_at,
      prevCreatedAt: row.created_at,
      eventId: row.id,
      pubkey: sess.pubkey,
      relays: editorRelays(c.env, user),
      handle: user?.handle ?? null,
      mainHost: c.env.MAIN_HOST.toLowerCase(),
    }),
  );
});

// --- POST /dashboard/preview — server-rendered markdown preview -----------------
// Runs the EXACT pipeline mirrorEvent uses at ingest (renderPost =
// markdown-it + sanitize), so preview HTML === published HTML byte for byte.
dashboardRoutes.post("/preview", async (c) => {
  const sess = c.var.session;
  if (!sess) return c.json({ error: "authentication required" }, 401);

  // Require Content-Length: a missing header would let a chunked / CL-less
  // POST pass a `Number(undefined ?? "0") === 0` check and buffer a
  // platform-sized body before renderPost's caps apply. Browsers always send
  // it for a fetch with a string body, so editor.js is unaffected.
  const clHeader = c.req.header("content-length");
  const contentLength = Number(clHeader);
  if (
    clHeader === undefined ||
    clHeader === "" ||
    !Number.isFinite(contentLength) ||
    contentLength > MAX_PREVIEW_BODY_BYTES
  ) {
    return c.json({ error: "missing or oversized body" }, 413);
  }

  if (
    !(await rateLimitAllows(
      c.env,
      `preview:pk:${sess.pubkey}`,
      PREVIEW_MAX,
      PREVIEW_WINDOW_SECONDS,
    ))
  ) {
    return c.json({ error: "rate limited, try again later" }, 429);
  }

  let markdown = "";
  try {
    const body: unknown = await c.req.json();
    if (
      body !== null &&
      typeof body === "object" &&
      "markdown" in body &&
      typeof (body as { markdown: unknown }).markdown === "string"
    ) {
      markdown = (body as { markdown: string }).markdown;
    } else {
      return c.json({ error: "body must be JSON with a markdown string" }, 400);
    }
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }

  return c.body(renderPost(markdown), 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
});
