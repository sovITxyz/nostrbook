/**
 * NIP-23 (kind 30023 long-form content) metadata mapping.
 *
 * Extracts render metadata from event tags with fallbacks:
 *   slug          ← `d` tag (replaceable identifier; "" when absent)
 *   title         ← `title` tag → first markdown heading → "Untitled"
 *   summary       ← `summary` tag (null when absent/empty)
 *   published_at  ← `published_at` tag (unix seconds) → created_at
 *   image         ← `image` tag, only when an absolute http(s) URL
 */
import type { NostrEvent } from "../nostr/event";
import { safeHttpUrl } from "./sanitize";

export type PostMeta = {
  slug: string;
  title: string;
  summary: string | null;
  published_at: number;
  image: string | null;
};

const MAX_TITLE = 200;
const MAX_SUMMARY = 500;

/** First value of the named tag, or null. */
export function firstTagValue(ev: NostrEvent, name: string): string | null {
  for (const tag of ev.tags) {
    if (tag[0] === name && typeof tag[1] === "string") return tag[1];
  }
  return null;
}

/** First ATX heading in the markdown body, with inline markers stripped. */
function titleFromContent(content: string): string | null {
  const m = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*$/m.exec(content);
  const raw = m?.[1];
  if (!raw) return null;
  const title = raw
    .replace(/[ \t]+#+$/, "") // trailing ATX closer
    .replace(/[*_`~]/g, "") // inline emphasis markers
    .trim();
  return title || null;
}

/** Map a kind 30023 event to its render metadata (tags + fallbacks). */
export function postMeta(ev: NostrEvent): PostMeta {
  const slug = firstTagValue(ev, "d") ?? "";

  const title = (
    firstTagValue(ev, "title")?.trim() ||
    titleFromContent(ev.content) ||
    "Untitled"
  ).slice(0, MAX_TITLE);

  const summaryTag = firstTagValue(ev, "summary")?.trim() ?? "";
  const summary = summaryTag ? summaryTag.slice(0, MAX_SUMMARY) : null;

  let published_at = ev.created_at;
  const pubRaw = firstTagValue(ev, "published_at")?.trim() ?? "";
  if (/^[0-9]{1,12}$/.test(pubRaw)) {
    const n = Number(pubRaw);
    if (n > 0) published_at = n;
  }

  const image = safeHttpUrl(firstTagValue(ev, "image"));

  return { slug, title, summary, published_at, image };
}

// Unrepresentable timestamps fall back to the unix epoch rather than "":
// callers interpolate these straight into Atom <updated> / sitemap
// <lastmod> / <time datetime>, where an empty value is well-formed XML but
// violates the RFC 3339 / W3C datetime requirement and can make feed
// consumers reject the document. Mirrors rfc822()'s epoch fallback in
// views/tenant/xml.ts.

/** YYYY-MM-DD for a unix-seconds timestamp (unix epoch when unrepresentable). */
export function isoDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  const safe = Number.isFinite(d.getTime()) ? d : new Date(0);
  return safe.toISOString().slice(0, 10);
}

/** Full ISO 8601 datetime for a unix-seconds timestamp (unix epoch when unrepresentable). */
export function isoDateTime(seconds: number): string {
  const d = new Date(seconds * 1000);
  const safe = Number.isFinite(d.getTime()) ? d : new Date(0);
  return safe.toISOString();
}
