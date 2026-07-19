import {
  DISCOVER_PAGE_SIZE,
  FEED_SELECT_COLUMNS,
  FEED_ZAP_JOIN,
  type FeedRow,
} from "./events";

/**
 * FTS5 search over mirrored posts (posts_fts) with strict MATCH-input
 * sanitization: user input NEVER reaches MATCH raw (P6).
 */

/** Hard cap on the raw query length considered (DoS bound). */
export const SEARCH_MAX_QUERY_CHARS = 256;

/** Hard cap on the number of terms handed to MATCH. */
export const SEARCH_MAX_TERMS = 8;

/** Max results returned per search (single page; relevance-ordered). */
export const SEARCH_RESULT_LIMIT = DISCOVER_PAGE_SIZE;

/**
 * Sanitize arbitrary user input into a safe FTS5 MATCH expression.
 *
 * Strategy: extract runs of Unicode letters/digits and wrap each run in
 * double quotes (an FTS5 phrase). Everything else — quotes, `*`, `^`, `-`,
 * parentheses, `:` column filters, `+`, backslashes — is a separator and
 * never reaches MATCH. Bareword operators (AND/OR/NOT/NEAR) survive only as
 * QUOTED phrases, where FTS5 treats them as plain terms. Quoted terms are
 * joined with spaces (implicit AND).
 *
 * This mirrors what the unicode61 tokenizer would keep anyway (it splits on
 * non-alphanumerics), so stripping punctuation does not change which
 * documents can match — it only removes operator semantics.
 *
 * Returns "" when nothing searchable remains; callers must then skip MATCH
 * entirely (FTS5 rejects an empty expression with an error).
 */
export function toMatchQuery(raw: string): string {
  const capped = raw.slice(0, SEARCH_MAX_QUERY_CHARS);
  const terms = capped.match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms
    .slice(0, SEARCH_MAX_TERMS)
    .map((t) => `"${t}"`)
    .join(" ");
}

/**
 * Search mirrored posts. Results are scoped EXACTLY like the discover feed
 * (P6 trap): kind 30023 only, `deleted = 0`, author JOIN with a claimed
 * handle and `blocked = 0` — posts_fts rows for unclaimed-npub mirrors,
 * blocked authors, or tombstoned posts never surface. FTS-row hygiene
 * (applyDelete removes rows) is NOT relied on; the join re-filters.
 *
 * Ordering is relevance-first via FTS5's bm25() aux function (valid here
 * because the statement carries a posts_fts MATCH). bm25 returns LOWER
 * scores for better matches, so the default ascending sort ranks best
 * first. The weights 10/5/1 map positionally to the posts_fts columns
 * (title, summary, content — see migrations/0001_init.sql): a title hit
 * outranks a summary hit outranks a body hit. Equal-relevance rows fall
 * back to created_at DESC, id ASC, keeping the order deterministic.
 *
 * Never throws on hostile input: the sanitizer guarantees an operator-free
 * MATCH expression. A REAL backend failure (D1 outage, schema drift, a
 * future sanitizer regression) returns `null` — a state DISTINCT from "no
 * results" — so the route can render a "temporarily unavailable" page and
 * outages stay visible in monitoring instead of masquerading as empty
 * result sets (review fix).
 */
export async function searchPosts(
  env: Env,
  query: string,
  limit: number = SEARCH_RESULT_LIMIT,
): Promise<FeedRow[] | null> {
  const match = toMatchQuery(query);
  if (match === "") return [];
  const safeLimit = Math.min(
    Math.max(1, Math.trunc(limit) || 1),
    SEARCH_RESULT_LIMIT,
  );
  try {
    const rs = await env.DB.prepare(
      `SELECT ${FEED_SELECT_COLUMNS}
       FROM posts_fts
       JOIN events e ON e.rowid = posts_fts.rowid
       JOIN users u ON u.pubkey = e.pubkey
       ${FEED_ZAP_JOIN}
       WHERE posts_fts MATCH ?1
         AND e.kind = 30023 AND e.deleted = 0
         AND u.handle IS NOT NULL AND u.blocked = 0
       ORDER BY bm25(posts_fts, 10.0, 5.0, 1.0), e.created_at DESC, e.id ASC
       LIMIT ?2`,
    )
      .bind(match, safeLimit)
      .all<FeedRow>();
    return rs.results;
  } catch (err) {
    // The sanitizer's output shape is unit-tested to be a valid FTS5
    // expression, so this can only fire on a genuine backend fault. Log
    // with the sanitized expression for diagnosis and surface the DISTINCT
    // degraded state to the caller (never a throw on this public path).
    console.error(
      `search query failed (match=${JSON.stringify(match)}):`,
      err,
    );
    return null;
  }
}
