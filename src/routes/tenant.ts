import { Hono } from "hono";
import type { Context } from "hono";
import type { DispatchEnv } from "../types";
import type { NostrEvent } from "../nostr/event";
import type { User } from "../services/users";
import type { BlogProfile } from "../views/tenant/layout";
import {
  getPost as getPostRow,
  listPostsByPubkey,
  rowToEvent,
} from "../services/events";
import { getProfile as getProfileRow } from "../services/profiles";
import { BlogHome } from "../views/tenant/home";
import { PostPage } from "../views/tenant/post";
import { NotFoundPage } from "../views/tenant/not-found";
import { rssFeed, atomFeed, sitemapXml } from "../views/tenant/xml";

/**
 * Blog subdomain routes (<handle>.MAIN_HOST).
 *
 * Post/profile data is pulled through a thin injectable provider; the
 * default is the D1-backed implementation (services/events +
 * services/profiles) wired in P3. Tests may still inject fixture-backed
 * providers via setTenantDataProvider.
 */

/** A post ready to render: the event (for tag metadata) + stored HTML body. */
export type TenantPost = { event: NostrEvent; html: string };

export type TenantDataProvider = {
  /** Owner profile (kind 0 → name/picture/about) or null. */
  getProfile(env: Env, pubkey: string): Promise<BlogProfile | null>;
  /** Kind 30023 posts for the owner, newest first, deleted excluded. */
  listPosts(env: Env, pubkey: string): Promise<NostrEvent[]>;
  /** Single kind 30023 post by d-tag slug (with ingest-rendered HTML), or null. */
  getPost(env: Env, pubkey: string, slug: string): Promise<TenantPost | null>;
};

/**
 * D1-backed default provider. getPost serves events.rendered — the HTML
 * produced by renderPost at MIRROR time (render-at-ingest contract). A row
 * with a NULL rendered column cannot come from mirrorEvent (which always
 * renders kind 30023); if one ever appears (manual insert, migration gap),
 * it is treated as NOT FOUND rather than rendered per request — the P2→P3
 * addendum forbids renderPost on the request path (up to ~150ms CPU on
 * hostile 32 KiB input vs the free-tier 10ms budget).
 */
const d1Provider: TenantDataProvider = {
  async getProfile(env, pubkey) {
    const row = await getProfileRow(env, pubkey);
    if (!row) return null;
    return { name: row.name, picture: row.picture, about: row.about };
  },
  async listPosts(env, pubkey) {
    const rows = await listPostsByPubkey(env, pubkey);
    return rows.map(rowToEvent);
  },
  async getPost(env, pubkey, slug) {
    const row = await getPostRow(env, pubkey, slug);
    if (!row || row.rendered === null) return null;
    return { event: rowToEvent(row), html: row.rendered };
  },
};

let provider: TenantDataProvider = d1Provider;

/**
 * TEST SEAM: install a fixture-backed data provider. Passing null restores
 * the D1-backed default.
 */
export function setTenantDataProvider(next: TenantDataProvider | null): void {
  provider = next ?? d1Provider;
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
      handle: ctx.handle,
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
  const post = await provider.getPost(c.env, ctx.pubkey, slug);
  if (
    !post ||
    post.event.kind !== 30023 ||
    post.event.pubkey !== ctx.pubkey
  ) {
    return notFound(c);
  }
  const profile = await provider.getProfile(c.env, ctx.pubkey);
  return c.html(
    PostPage({
      handle: ctx.handle,
      profile,
      event: post.event,
      bodyHtml: post.html,
      themeCss: ctx.themeCss,
      mainHost: ctx.mainHost,
    }),
  );
});

// Anything else (deep paths, non-GET) → rendered 404.
tenantRoutes.all("*", (c) => notFound(c));
