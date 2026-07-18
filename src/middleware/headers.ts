import type { MiddlewareHandler } from "hono";
import type { AppEnv, Site } from "../types";

/**
 * Security headers by host class (P7).
 *
 * Two response classes exist:
 *
 *   BLOG pages — tenant subdomains (<handle>.MAIN_HOST) AND the apex
 *   /npub1… views (the same tenant views rendered under a base path for
 *   unclaimed keys). These render UNTRUSTED relay content (sanitized at
 *   ingest) and are deliberately JS-free: the CSP forbids scripts entirely
 *   (default-src 'none' + no script-src). Images and media may come from
 *   anywhere (markdown embeds arbitrary URLs); styles are the shared base
 *   stylesheet ('self') plus the sanitized inline theme CSS
 *   ('unsafe-inline' — required by the per-blog <style> tag, and by style
 *   attributes nowhere else).
 *
 *   APEX pages — everything else on MAIN_HOST (landing, login, dashboard,
 *   editor, discover, search, JSON APIs, .well-known). These DO ship
 *   first-party JS (/js/login.js, /js/editor.js) and the Cloudflare
 *   Turnstile widget (external script + iframe from
 *   challenges.cloudflare.com — the ONLY third-party origin in the app).
 *   The editor additionally needs: connect-src 'self' (login/preview/mirror
 *   fetches) + wss: (client-side relay broadcast to arbitrary user-chosen
 *   relays), and img-src/media-src * data: so the preview renders posts with
 *   the same fidelity as the blog CSP. Forms only ever post same-origin.
 *
 * Registered FIRST on the outer app (before guard/tenant), so headers land
 * on EVERY response: guard 404s (unknown/spoofed hosts), tenant 404s
 * (unclaimed/blocked subdomains), cache HITS (the Cache API stores the
 * response from the miss, but this middleware re-stamps headers on every
 * pass — hit and miss carry identical policy), redirects, RSS/Atom/sitemap
 * XML, robots.txt, and JSON responses alike. Static assets under public/
 * (css/js) are served by the Static Assets layer BEFORE the Worker runs and
 * do not pass through here — they are subresources with correct
 * Content-Types, not documents (see docs/ops.md).
 */

/**
 * Blog-class CSP. Per the P7 contract, with ratification-pending changes
 * (bundled in the P7 addendum in docs/phases/CONTRACTS.md):
 *
 *   - style-src gains 'self': every blog page loads the shared base
 *     stylesheet /css/style.css via <link rel="stylesheet"> (same origin) —
 *     the contract string ('unsafe-inline' alone) would strip ALL base
 *     styling from every blog. Safe because the same-origin namespace is
 *     fully platform-controlled: public/ holds only first-party files (no
 *     user-supplied content is ever served from /css or /js) and every
 *     WORKER response carries nosniff with a non-CSS Content-Type, so no
 *     attacker-influenced same-origin bytes are loadable as a stylesheet.
 *     (NOTE: Static Assets responses bypass the Worker and carry NO security
 *     headers — never lean on assets themselves having nosniff.)
 *
 *   - base-uri 'none' + form-action 'none' appended (P7 review fix): neither
 *     directive falls back to default-src, and blog pages are the ones
 *     rendering hostile relay content. The sanitizer already drops
 *     <base>/<form>, but it must not be the ONLY line of defense — a
 *     sanitizer regression letting through <base href> would rewrite every
 *     relative URL, and <form action> would harvest input, both silently.
 *     Blog markup legitimately ships neither element, so nothing breaks.
 */
export const BLOG_CSP =
  "default-src 'none'; img-src * data:; style-src 'self' 'unsafe-inline'; " +
  "media-src *; base-uri 'none'; form-action 'none'";

/**
 * Apex-class CSP — as tight as the pages' real needs allow (derived from
 * the code: login.js/editor.js are same-origin; Turnstile needs its script
 * + iframe origin; the editor broadcasts to user relays over wss: and its
 * preview renders arbitrary post images/media; all forms are same-origin).
 * base-uri/form-action/frame-ancestors do NOT fall back to default-src and
 * are pinned explicitly.
 */
export const APEX_CSP =
  "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; " +
  "style-src 'self' 'unsafe-inline'; img-src * data:; media-src *; " +
  // connect-src: 'self' (login/preview/mirror fetches) + wss: (client-side
  // relay broadcast to user-chosen relays) + the four Blossom media servers
  // the editor uploads images to via browser PUT (BUD-02 /upload, BUD-04
  // /mirror). These are XHR/fetch destinations only, NOT script sources
  // (script-src is untouched); img-src * already covers displaying the
  // resulting image URLs on any host.
  "connect-src 'self' wss: https://blossom.band https://blossom.nostr.build " +
  "https://nostr.download https://cdn.nostrcheck.me; " +
  "frame-src https://challenges.cloudflare.com; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Referrer policy applied to every response (both host classes). */
export const REFERRER_POLICY = "strict-origin-when-cross-origin";

/**
 * Apex paths that render BLOG pages: /npub1…, /npub1…/rss.xml, /npub1…/:slug.
 * Matches the route shape in src/routes/main.ts (NPUB_PARAM) — a fixed
 * "npub1" prefix plus 58 bech32 data chars, then end-of-path or a slash.
 * Shape-valid-but-bad-checksum npubs 404 through the same views and get the
 * same class, which is exactly right.
 */
const NPUB_PATH = /^\/npub1[a-z0-9]{58}(?:\/|$)/;

/** Is this apex path one of the /npub1… blog views? Exported for tests. */
export function isNpubPath(path: string): boolean {
  return NPUB_PATH.test(path);
}

/**
 * Security-headers middleware (outer app, FIRST — see module docs). Class
 * selection happens AFTER next(): the tenant middleware has resolved
 * c.var.site by then. When guard/tenant short-circuited (unknown host,
 * unclaimed subdomain 404) site is unset for the former and the strictest
 * class (apex: XFO DENY + apex CSP) is applied as the safe default.
 */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();

  const headers = c.res.headers;
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", REFERRER_POLICY);

  // c.var.site is typed non-nullable but genuinely absent when the guard
  // 404s before tenant resolution runs.
  const site = c.var.site as Site | undefined;
  const blogClass =
    site?.type === "blog" ||
    (site?.type === "main" && isNpubPath(c.req.path));

  if (blogClass) {
    headers.set("Content-Security-Policy", BLOG_CSP);
  } else {
    headers.set("Content-Security-Policy", APEX_CSP);
    // Legacy twin of frame-ancestors 'none' (already in APEX_CSP); the
    // contract asks for it explicitly on the apex.
    headers.set("X-Frame-Options", "DENY");
  }
};
