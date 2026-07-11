import { Hono } from "hono";
import type { Context } from "hono";
import type { DispatchEnv } from "../types";
import type { NostrEvent } from "../nostr/event";
import type { User } from "../services/users";
import type { BlogProfile } from "../views/tenant/layout";
import { BlogHome } from "../views/tenant/home";
import { PostPage } from "../views/tenant/post";
import { NotFoundPage } from "../views/tenant/not-found";
import { rssFeed, atomFeed, sitemapXml } from "../views/tenant/xml";

/**
 * Blog subdomain routes (<handle>.MAIN_HOST). P2 scope: RENDER ONLY.
 *
 * Post/profile data is pulled through a thin injectable provider so P3 can
 * swap in the D1-backed implementation (services/events + services/profiles)
 * without touching the render path. Tests inject fixture-backed providers.
 */

export type TenantDataProvider = {
  /** Owner profile (kind 0 → name/picture/about) or null. */
  getProfile(env: Env, pubkey: string): Promise<BlogProfile | null>;
  /** Kind 30023 posts for the owner, newest first, deleted excluded. */
  listPosts(env: Env, pubkey: string): Promise<NostrEvent[]>;
  /** Single kind 30023 post by d-tag slug, or null. */
  getPost(env: Env, pubkey: string, slug: string): Promise<NostrEvent | null>;
};

const emptyProvider: TenantDataProvider = {
  getProfile: async () => null,
  listPosts: async () => [],
  getPost: async () => null,
};

let provider: TenantDataProvider = emptyProvider;

/**
 * Install the data provider (P3: D1-backed; tests: fixtures).
 * Passing null resets to the empty provider.
 */
export function setTenantDataProvider(next: TenantDataProvider | null): void {
  provider = next ?? emptyProvider;
}

/** Per-request blog context derived from the resolved Site. */
type BlogCtx = {
  user: User;
  pubkey: string;
  handle: string;
  themeCss: string;
  baseUrl: string;
  mainHost: string;
};

/** Owner theme CSS from users.settings (sanitized later, in the layout). */
function themeCssOf(user: User): string {
  try {
    const settings: unknown = JSON.parse(user.settings);
    if (
      settings !== null &&
      typeof settings === "object" &&
      "css" in settings &&
      typeof (settings as { css: unknown }).css === "string"
    ) {
      return (settings as { css: string }).css;
    }
  } catch {
    // malformed settings blob → no theme
  }
  return "";
}

function blogCtx(c: Context<DispatchEnv>): BlogCtx | null {
  const site = c.var.site;
  if (site.type !== "blog" || !site.user.handle) return null;
  const mainHost = c.env.MAIN_HOST.toLowerCase();
  const handle = site.user.handle.toLowerCase();
  return {
    user: site.user,
    pubkey: site.pubkey,
    handle,
    themeCss: themeCssOf(site.user),
    baseUrl: `https://${handle}.${mainHost}`,
    mainHost,
  };
}

function notFound(c: Context<DispatchEnv>) {
  const site = c.var.site;
  const handle =
    site.type === "blog" && site.user.handle ? site.user.handle : undefined;
  return c.html(NotFoundPage({ handle }), 404);
}

/** Routes served on blog subdomains (<handle>.MAIN_HOST). */
export const tenantRoutes = new Hono<DispatchEnv>();

tenantRoutes.get("/", async (c) => {
  const ctx = blogCtx(c);
  if (!ctx) return notFound(c);
  const [profile, posts] = await Promise.all([
    provider.getProfile(c.env, ctx.pubkey),
    provider.listPosts(c.env, ctx.pubkey),
  ]);
  return c.html(
    BlogHome({
      user: ctx.user,
      profile,
      posts,
      themeCss: ctx.themeCss,
      mainHost: ctx.mainHost,
    }),
  );
});

tenantRoutes.get("/rss.xml", async (c) => {
  const ctx = blogCtx(c);
  if (!ctx) return notFound(c);
  const [profile, posts] = await Promise.all([
    provider.getProfile(c.env, ctx.pubkey),
    provider.listPosts(c.env, ctx.pubkey),
  ]);
  const xml = rssFeed({
    title: profile?.name?.trim() || `@${ctx.handle}`,
    description: profile?.about?.trim() || `Posts by @${ctx.handle}`,
    baseUrl: ctx.baseUrl,
    handle: ctx.handle,
    posts,
  });
  return c.body(xml, 200, {
    "Content-Type": "application/rss+xml; charset=utf-8",
  });
});

tenantRoutes.get("/atom.xml", async (c) => {
  const ctx = blogCtx(c);
  if (!ctx) return notFound(c);
  const [profile, posts] = await Promise.all([
    provider.getProfile(c.env, ctx.pubkey),
    provider.listPosts(c.env, ctx.pubkey),
  ]);
  const xml = atomFeed({
    title: profile?.name?.trim() || `@${ctx.handle}`,
    description: profile?.about?.trim() || `Posts by @${ctx.handle}`,
    baseUrl: ctx.baseUrl,
    handle: ctx.handle,
    posts,
  });
  return c.body(xml, 200, {
    "Content-Type": "application/atom+xml; charset=utf-8",
  });
});

tenantRoutes.get("/sitemap.xml", async (c) => {
  const ctx = blogCtx(c);
  if (!ctx) return notFound(c);
  const posts = await provider.listPosts(c.env, ctx.pubkey);
  const xml = sitemapXml({ baseUrl: ctx.baseUrl, posts });
  return c.body(xml, 200, {
    "Content-Type": "application/xml; charset=utf-8",
  });
});

tenantRoutes.get("/robots.txt", (c) => {
  const ctx = blogCtx(c);
  if (!ctx) return notFound(c);
  return c.text(
    `User-agent: *\nAllow: /\n\nSitemap: ${ctx.baseUrl}/sitemap.xml\n`,
  );
});

tenantRoutes.get("/:slug", async (c) => {
  const ctx = blogCtx(c);
  if (!ctx) return notFound(c);
  const slug = c.req.param("slug");
  const ev = await provider.getPost(c.env, ctx.pubkey, slug);
  if (!ev || ev.kind !== 30023 || ev.pubkey !== ctx.pubkey) {
    return notFound(c);
  }
  const profile = await provider.getProfile(c.env, ctx.pubkey);
  return c.html(
    PostPage({
      user: ctx.user,
      profile,
      event: ev,
      themeCss: ctx.themeCss,
      mainHost: ctx.mainHost,
    }),
  );
});

// Anything else (deep paths, non-GET) → rendered 404.
tenantRoutes.all("*", (c) => notFound(c));
