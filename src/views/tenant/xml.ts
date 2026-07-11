/**
 * XML documents for blog subdomains: RSS 2.0, Atom, sitemap.xml.
 *
 * Built as strings (hono/jsx is HTML-oriented). EVERY interpolated value
 * goes through xmlEscape, which also strips characters that are not legal
 * in XML 1.0 (untrusted event tags may carry control chars). Feeds are
 * deterministic: timestamps come from the events, never from Date.now().
 */
import type { NostrEvent } from "../../nostr/event";
import { postMeta, isoDateTime, type PostMeta } from "../../markdown/nip23";

// XML 1.0 forbids C0 controls except \t \n \r — even as character references.
// eslint-disable-next-line no-control-regex
const XML_INVALID_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/** Escape a string for XML text or attribute content. */
export function xmlEscape(s: string): string {
  return s
    .replace(XML_INVALID_RE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** RFC 822-style date for RSS <pubDate>. */
function rfc822(seconds: number): string {
  const d = new Date(seconds * 1000);
  return Number.isFinite(d.getTime()) ? d.toUTCString() : new Date(0).toUTCString();
}

type FeedOpts = {
  /** Blog display title (profile name or @handle). */
  title: string;
  /** Short blog description (profile about or a default). */
  description: string;
  /** Absolute blog origin, no trailing slash: https://alice.nostrbook.net */
  baseUrl: string;
  /** Author handle for Atom <author>. */
  handle: string;
  /** Kind 30023 events, newest first. */
  posts: NostrEvent[];
};

function postUrl(baseUrl: string, meta: PostMeta): string {
  return `${baseUrl}/${encodeURIComponent(meta.slug)}`;
}

/**
 * Map events to metas, dropping posts with an empty `d` tag. NIP-23 allows
 * one d-tagless replaceable event per author (d_tag defaults to ""), but
 * such a post has no addressable URL here: `${baseUrl}/` + encoded "" is
 * the blog home, so listing it would emit links/locs that collapse onto
 * the home URL (duplicate sitemap <loc>, feed items pointing at "/").
 */
function addressableMetas(posts: NostrEvent[]): PostMeta[] {
  return posts.map(postMeta).filter((m) => m.slug !== "");
}

function newestPublished(metas: PostMeta[]): number {
  let newest = 0;
  for (const m of metas) if (m.published_at > newest) newest = m.published_at;
  return newest;
}

/** RSS 2.0 feed. */
export function rssFeed(opts: FeedOpts): string {
  const metas = addressableMetas(opts.posts);
  const items = metas
    .map((m) => {
      const url = xmlEscape(postUrl(opts.baseUrl, m));
      const summary = m.summary
        ? `<description>${xmlEscape(m.summary)}</description>`
        : "";
      return (
        `<item>` +
        `<title>${xmlEscape(m.title)}</title>` +
        `<link>${url}</link>` +
        `<guid isPermaLink="true">${url}</guid>` +
        `<pubDate>${xmlEscape(rfc822(m.published_at))}</pubDate>` +
        summary +
        `</item>`
      );
    })
    .join("\n");
  const lastBuild =
    metas.length > 0
      ? `<lastBuildDate>${xmlEscape(rfc822(newestPublished(metas)))}</lastBuildDate>`
      : "";

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
    `<channel>\n` +
    `<title>${xmlEscape(opts.title)}</title>\n` +
    `<link>${xmlEscape(opts.baseUrl)}/</link>\n` +
    `<description>${xmlEscape(opts.description)}</description>\n` +
    `<atom:link href="${xmlEscape(opts.baseUrl)}/rss.xml" rel="self" type="application/rss+xml"/>\n` +
    (lastBuild ? lastBuild + "\n" : "") +
    items +
    (items ? "\n" : "") +
    `</channel>\n` +
    `</rss>\n`
  );
}

/** Atom feed. */
export function atomFeed(opts: FeedOpts): string {
  const metas = addressableMetas(opts.posts);
  const updated = isoDateTime(
    metas.length > 0 ? newestPublished(metas) : 0,
  );
  const entries = metas
    .map((m) => {
      const url = xmlEscape(postUrl(opts.baseUrl, m));
      const summary = m.summary
        ? `<summary>${xmlEscape(m.summary)}</summary>`
        : "";
      return (
        `<entry>` +
        `<title>${xmlEscape(m.title)}</title>` +
        `<id>${url}</id>` +
        `<link href="${url}"/>` +
        `<updated>${xmlEscape(isoDateTime(m.published_at))}</updated>` +
        summary +
        `</entry>`
      );
    })
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom">\n` +
    `<title>${xmlEscape(opts.title)}</title>\n` +
    `<subtitle>${xmlEscape(opts.description)}</subtitle>\n` +
    `<id>${xmlEscape(opts.baseUrl)}/</id>\n` +
    `<link href="${xmlEscape(opts.baseUrl)}/"/>\n` +
    `<link rel="self" href="${xmlEscape(opts.baseUrl)}/atom.xml"/>\n` +
    `<updated>${xmlEscape(updated)}</updated>\n` +
    `<author><name>${xmlEscape(opts.handle)}</name></author>\n` +
    entries +
    (entries ? "\n" : "") +
    `</feed>\n`
  );
}

/** sitemap.xml: blog home + one entry per post. */
export function sitemapXml(opts: {
  baseUrl: string;
  posts: NostrEvent[];
}): string {
  const urls = [`<url><loc>${xmlEscape(opts.baseUrl)}/</loc></url>`];
  for (const m of addressableMetas(opts.posts)) {
    urls.push(
      `<url>` +
        `<loc>${xmlEscape(postUrl(opts.baseUrl, m))}</loc>` +
        `<lastmod>${xmlEscape(isoDateTime(m.published_at))}</lastmod>` +
        `</url>`,
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.join("\n") +
    `\n</urlset>\n`
  );
}
