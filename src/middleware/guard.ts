import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

/** RFC 1035 DNS label: a-z / 0-9, optional interior hyphens, 1–63 chars. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Loopback hosts wrangler dev listens on; treated as the apex. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Max total hostname length per RFC 1035 (253 chars of presentation form). */
const MAX_HOSTNAME_LENGTH = 253;

/**
 * Normalize a raw Host header value to a lowercase hostname with no port.
 *
 * Uses the URL parser so bracketed IPv6 (`[::1]:8787` → `[::1]`), uppercase
 * hosts, and IDNA forms are handled correctly, instead of a naive
 * `split(":")` (which mangles IPv6). Malformed hosts (NUL bytes, spaces,
 * other forbidden host code points), empty hosts, and hostnames longer than
 * 253 chars return null.
 *
 * Exported for direct unit testing — some byte sequences (e.g. NUL) cannot
 * be sent through the Headers API in tests.
 */
export function normalizeHostname(raw: string): string | null {
  let hostname: string;
  try {
    hostname = new URL("http://" + raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostname.length === 0 || hostname.length > MAX_HOSTNAME_LENGTH) {
    return null;
  }
  return hostname;
}

/**
 * Host guard: classifies the request Host header before anything else runs.
 *
 * Accepted host classes:
 *   - MAIN_HOST exactly (e.g. nbread.lol)          → passes, host=MAIN_HOST
 *   - single valid DNS label subdomain (alice.…)      → passes, host as-is
 *   - localhost / 127.0.0.1 / [::1] (wrangler dev)    → treated as MAIN_HOST
 * Everything else (nbread.lol.evil.com, deep.sub.nbread.lol, malformed
 * or hostile labels, missing host, unrelated domains) → 404.
 *
 * The guard is the contracted choke point for host input: everything
 * downstream (tenant D1 lookup, cache keys built from c.var.host) relies on
 * c.var.host being a normalized, RFC-1035-shaped hostname.
 *
 * Sets c.var.host to the normalized hostname (lowercase, no port).
 */
export const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  let raw = c.req.header("host") ?? new URL(c.req.url).host;

  // DEV ONLY: wrangler dev's proxy rewrites the Host header to the first
  // configured route, which makes subdomains untestable locally. When (and
  // only when) ENVIRONMENT === "development", allow X-Forwarded-Host to
  // override so `curl -H 'X-Forwarded-Host: alice.nbread.lol'` works.
  // The committed wrangler.jsonc ships ENVIRONMENT=production, so a stock
  // `wrangler deploy` fails closed and this header is ignored entirely
  // (it is client-spoofable). Dev gets ENVIRONMENT=development from
  // .dev.vars (wrangler dev) / vitest.config.ts (tests).
  if (c.env.ENVIRONMENT === "development") {
    const forwarded = c.req.header("x-forwarded-host");
    if (forwarded) raw = forwarded;
  }

  const hostname = normalizeHostname(raw);
  if (hostname === null) {
    return c.text("Not found", 404);
  }
  const main = c.env.MAIN_HOST.toLowerCase();

  if (LOOPBACK_HOSTS.has(hostname)) {
    // wrangler dev convenience: treat the loopback host as the apex.
    c.set("host", main);
    return next();
  }

  if (hostname === main) {
    c.set("host", hostname);
    return next();
  }

  if (hostname.endsWith("." + main)) {
    const label = hostname.slice(0, -(main.length + 1));
    // Only single, RFC-1035-valid labels are valid blog hosts. This rejects
    // deep subdomains (dots), underscores, leading/trailing hyphens,
    // whitespace/control chars, and labels over 63 chars — defense in depth
    // for the D1 handle lookup and host-keyed cache keys downstream.
    if (DNS_LABEL.test(label)) {
      c.set("host", hostname);
      return next();
    }
  }

  // Unknown / spoofed / malformed host class (e.g. nbread.lol.evil.com).
  return c.text("Not found", 404);
};
