// Relay REQ query engine: translates sanitized NIP-01 filters into SQL over
// the existing D1 `events` table (the same store mirrorEvent writes — relay
// and blog can never disagree). One parameterized statement per filter;
// generic tag filters (#e/#t/…) are applied as a JS post-filter on the SQL
// candidates, bounded by the per-filter LIMIT already clamped upstream by
// sanitizeFilters.
import type { SanitizedFilter } from "./types";

/** Row shape served back to REQ subscribers (raw = canonical stored JSON). */
export type QueryRow = {
  id: string;
  kind: number;
  created_at: number;
  raw: string;
};

/** `?, ?, ?` placeholder list for a dynamic IN clause (values stay bound). */
function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ");
}

/**
 * Does the event raw JSON satisfy every generic tag filter? NIP-01: for each
 * `#x` filter the event needs at least one `x` tag whose value is in the
 * filter's list; multiple tag filters AND together. Keys are accepted with or
 * without the leading `#` (tolerant of either sanitizer representation).
 * Unparseable raw rows are excluded (fail closed — never serve garbage).
 */
function passesTagFilters(
  raw: string,
  tagFilters: Record<string, string[]>,
): boolean {
  let tags: unknown;
  try {
    const ev = JSON.parse(raw) as { tags?: unknown };
    tags = ev.tags;
  } catch {
    return false;
  }
  if (!Array.isArray(tags)) return false;
  for (const [key, values] of Object.entries(tagFilters)) {
    const letter = key.startsWith("#") ? key.slice(1) : key;
    const hit = tags.some(
      (tag) =>
        Array.isArray(tag) &&
        tag[0] === letter &&
        typeof tag[1] === "string" &&
        values.includes(tag[1]),
    );
    if (!hit) return false;
  }
  return true;
}

/**
 * Execute sanitized REQ filters against D1.
 *
 * Per filter: WHERE deleted = 0 plus the SQL-translatable keys (ids, authors,
 * kinds, #d, since, until), ORDER BY created_at DESC, id ASC, LIMIT the
 * filter's clamped limit. Kind-5 delete markers are stored with deleted = 0,
 * so deletes stay servable while tombstoned posts never are.
 *
 * Results are merged across filters by id (an event matching several filters
 * is served once), re-sorted globally (created_at DESC, id ASC), and capped
 * at the max of the filters' limits.
 */
export async function queryEvents(
  env: Env,
  filters: SanitizedFilter[],
): Promise<QueryRow[]> {
  const byId = new Map<string, QueryRow>();
  let globalCap = 0;

  for (const f of filters) {
    globalCap = Math.max(globalCap, f.limit);

    const where: string[] = ["deleted = 0"];
    const params: (string | number)[] = [];

    if (f.ids && f.ids.length > 0) {
      where.push(`id IN (${placeholders(f.ids.length)})`);
      params.push(...f.ids);
    }
    if (f.authors && f.authors.length > 0) {
      where.push(`pubkey IN (${placeholders(f.authors.length)})`);
      params.push(...f.authors);
    }
    if (f.kinds && f.kinds.length > 0) {
      where.push(`kind IN (${placeholders(f.kinds.length)})`);
      params.push(...f.kinds);
    }
    if (f.dTags && f.dTags.length > 0) {
      where.push(`d_tag IN (${placeholders(f.dTags.length)})`);
      params.push(...f.dTags);
    }
    if (f.since !== undefined) {
      where.push("created_at >= ?");
      params.push(f.since);
    }
    if (f.until !== undefined) {
      where.push("created_at <= ?");
      params.push(f.until);
    }

    const stmt = env.DB.prepare(
      `SELECT id, kind, created_at, raw FROM events
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, id ASC LIMIT ?`,
    ).bind(...params, f.limit);

    const { results } = await stmt.all<QueryRow>();
    const tagFilters = f.tagFilters;
    const hasTagFilters =
      tagFilters !== undefined && Object.keys(tagFilters).length > 0;

    for (const row of results) {
      if (byId.has(row.id)) continue;
      if (hasTagFilters && !passesTagFilters(row.raw, tagFilters)) continue;
      byId.set(row.id, row);
    }
  }

  const merged = [...byId.values()].sort((a, b) =>
    a.created_at !== b.created_at
      ? b.created_at - a.created_at
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  );
  return merged.slice(0, globalCap);
}
