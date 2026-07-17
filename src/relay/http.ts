/**
 * Worker-side /relay endpoint (packet 3).
 *
 * Registered on the OUTER Hono app BEFORE securityHeaders/guard/tenant
 * (src/app.ts): a successful upgrade returns an immutable 101 response —
 * securityHeaders' headers.set() would throw on it — and the guard/tenant/
 * csrf/session stack has no business running per-upgrade. That means this
 * handler must do its own host self-check and set its own response headers.
 *
 * Split of duties (plan §B): the DO serves ONLY WebSocket traffic; NIP-11
 * and the plain info page are answered here so an information fetch never
 * spends a DO request. Denied upgrades (per-IP rate limit) are also decided
 * here for the same reason.
 */
import type { Context } from "hono";
import { normalizeHostname } from "../middleware/guard";
import { rateLimitAllows } from "../services/ratelimit";
import type { AppEnv } from "../types";
import { nip11Document } from "./nip11";
import { selfRelayUrl } from "./url";

/** Per-IP upgrade budget: 30 per 10 minutes (D1 rate_limits, fail-closed). */
export const UPGRADE_IP_MAX = 30;
export const UPGRADE_IP_WINDOW_SECONDS = 600;

/**
 * Loopback hosts wrangler dev listens on — same set the guard treats as the
 * apex (src/middleware/guard.ts LOOPBACK_HOSTS).
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Plain-text response carrying the same nosniff/Referrer-Policy hardening the
 * securityHeaders middleware adds to every OTHER Worker response. /relay is
 * registered BEFORE that middleware (immutable 101s), so these short bodies
 * (404 wrong-host, 429 rate-limited, info page) must set the headers
 * themselves — matching the "headers land on every response" invariant.
 */
function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}

/** GET /relay | WS upgrade — see module docs. */
export async function relayEndpoint(c: Context<AppEnv>): Promise<Response> {
  // Host self-check FIRST (mirrors guard semantics: normalized hostname must
  // be the apex, or a loopback dev host). The route pattern is path-only, so
  // without this check alice.nbread.lol/relay and hostile Host headers would
  // reach the relay.
  const rawHost = c.req.header("host") ?? new URL(c.req.url).host;
  const hostname = normalizeHostname(rawHost);
  const main = c.env.MAIN_HOST.toLowerCase();
  if (hostname === null || (hostname !== main && !LOOPBACK_HOSTS.has(hostname))) {
    return textResponse("Not found", 404);
  }

  // WebSocket upgrade → per-IP rate limit, then hand the RAW request to the
  // single global DO and return its response UNTOUCHED (101s are immutable).
  if (c.req.header("Upgrade")?.toLowerCase() === "websocket") {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const allowed = await rateLimitAllows(
      c.env,
      `relay:ip:${ip}`,
      UPGRADE_IP_MAX,
      UPGRADE_IP_WINDOW_SECONDS,
    );
    if (!allowed) {
      // Fail-closed (D1 error denies too); a denied upgrade never spends a
      // DO request.
      return textResponse("rate limited, try again later", 429);
    }
    const stub = c.env.RELAY_DO.get(c.env.RELAY_DO.idFromName("relay:v1"));
    return stub.fetch(c.req.raw);
  }

  // NIP-11 relay information document. Headers are set manually — this route
  // bypasses securityHeaders by design.
  if ((c.req.header("Accept") ?? "").includes("application/nostr+json")) {
    return Response.json(nip11Document(c.env), {
      headers: {
        "Content-Type": "application/nostr+json",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  // Plain browser hit: a tiny text info page.
  const body = [
    "nbread relay",
    "",
    `  ${selfRelayUrl(c.env)}`,
    "",
    "Reads are open; writes are restricted to claimed nbread.lol handles",
    "(NIP-42 auth; kinds 30023, 5, and 0 — own events only).",
    "",
    "Relay info: request this URL with Accept: application/nostr+json (NIP-11).",
    `Docs: https://${main}/docs`,
    "",
  ].join("\n");
  return textResponse(body);
}
