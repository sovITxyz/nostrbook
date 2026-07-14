import type { MiddlewareHandler } from "hono";
import type { DispatchEnv } from "../types";

/** Edge cache TTL (contract: s-maxage=3600). */
export const CACHE_TTL_SECONDS = 3600;

/**
 * Minimal surface of the Workers default cache. @types/node's undici
 * CacheStorage shadows the Workers-generated one at typecheck time (no
 * `default` property), so access goes through this typed accessor. Runtime
 * behavior is unchanged — it IS caches.default.
 */
export type EdgeCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
};

/** The Workers default Cache API instance. */
export function defaultCache(): EdgeCache {
  return (caches as unknown as { default: EdgeCache }).default;
}

/** Response header exposing hit/miss so tests (and ops) can observe caching. */
export const CACHE_STATUS_HEADER = "X-Nbread-Cache";

/**
 * Cache key per contract: https://cache.internal/<host><path>?g=<gen>.
 * The host is rebuilt from the RESOLVED tenant (handle + MAIN_HOST), never
 * from request headers — the dev-only X-Forwarded-Host affordance and any
 * header games therefore cannot poison another tenant's cache entries. The
 * generation comes from KV gen:<pubkey> (missing = "0"); mirrorEvent bumps
 * it on every stored change, which retargets all keys for that blog and
 * strands the old entries until their TTL expires.
 */
export function cacheKey(host: string, path: string, gen: string): Request {
  return new Request(`https://cache.internal/${host}${path}?g=${gen}`);
}

/**
 * Edge cache middleware for PUBLIC tenant GETs (blog sub-app only; the apex
 * is never cached here). Reads/writes the Cache API; cache failures degrade
 * to serving uncached.
 */
export const cache: MiddlewareHandler<DispatchEnv> = async (c, next) => {
  const site = c.var.site;
  if (c.req.method !== "GET" || site.type !== "blog" || !site.user.handle) {
    return next();
  }

  let gen: string;
  try {
    gen = (await c.env.KV.get(`gen:${site.pubkey}`)) ?? "0";
  } catch {
    // KV outage or free-tier read quota exhausted: "cache failures degrade
    // to serving uncached" must include the gen read, or every page view
    // becomes a 500 while D1 and the Cache API are perfectly healthy.
    return next();
  }
  const host = `${site.user.handle.toLowerCase()}.${c.env.MAIN_HOST.toLowerCase()}`;
  const key = cacheKey(host, new URL(c.req.url).pathname, gen);

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

  await next();

  if (c.res.status === 200) {
    c.res.headers.set(
      "Cache-Control",
      `public, s-maxage=${CACHE_TTL_SECONDS}`,
    );
    c.res.headers.set(CACHE_STATUS_HEADER, "miss");
    try {
      await defaultCache().put(key, c.res.clone());
    } catch {
      // Not cacheable / cache write failed — response still goes out.
    }
  }
};
