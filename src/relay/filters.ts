/**
 * REQ filter sanitation + in-memory event matching (packet 1). Pure — no I/O.
 *
 * sanitizeFilters is the single choke point between untrusted REQ payloads
 * and everything downstream (SQL translation in the query engine, JSON
 * persistence in DO SQLite subs rows, live fan-out matching): every array is
 * capped, every hex string validated, and `limit` is always materialized, so
 * a SanitizedFilter can be trusted blindly. Cap violations are ERRORS (the
 * REQ gets a CLOSED), not silent truncation — a silently narrowed filter
 * would return misleading results. EMPTY lists are also errors: NIP-01's
 * "matches nothing" reading and the SQL engine's "no constraint" reading
 * would otherwise disagree, so the ambiguity is rejected at the choke point
 * and neither engine ever sees an empty list.
 */
import { getDTag, MAX_TAG_ITEM_LENGTH, type NostrEvent } from "../nostr/event";
import type { SanitizedFilter } from "./types";

/** Plan caps (docs: plan §B REQ engine; NIP-11 limitation mirrors these). */
export const MAX_REQ_FILTERS = 4;
export const MAX_FILTER_IDS = 50;
export const MAX_FILTER_AUTHORS = 20;
export const MAX_FILTER_KINDS = 10;
export const MAX_TAG_FILTER_VALUES = 20;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 100;

const HEX_64 = /^[0-9a-f]{64}$/;
/** NIP-01 tag filters are `#<single-letter>` (a–z, A–Z) only. */
const TAG_FILTER_KEY = /^#([a-zA-Z])$/;

type ErrorResult = { error: string };

/**
 * Sanitize the raw filter list of one REQ (`msg.slice(2)`), enforcing the
 * plan caps: ≤4 filters; ids ≤50 / authors ≤20 (64-hex lowercase); kinds ≤10
 * (integers 0–65535); since/until non-negative integers; limit clamped to
 * [1, 500] (default 100); `#d` and other single-letter tag filters ≤20
 * string values each. Unknown non-tag keys (e.g. `search`) and non-single-
 * letter `#…` keys are ignored per NIP-01. Never throws.
 */
export function sanitizeFilters(raw: unknown): SanitizedFilter[] | ErrorResult {
  if (!Array.isArray(raw)) {
    return { error: "filters must be objects" };
  }
  if (raw.length === 0) {
    return { error: "REQ needs at least one filter" };
  }
  if (raw.length > MAX_REQ_FILTERS) {
    return { error: `too many filters (max ${MAX_REQ_FILTERS})` };
  }
  const out: SanitizedFilter[] = [];
  for (const item of raw) {
    const result = sanitizeFilter(item);
    if ("error" in result) return result;
    out.push(result);
  }
  return out;
}

/** Sanitize one filter object. */
function sanitizeFilter(item: unknown): SanitizedFilter | ErrorResult {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    return { error: "filter must be an object" };
  }
  const rec = item as Record<string, unknown>;
  const f: SanitizedFilter = { limit: DEFAULT_LIMIT };

  if (rec.ids !== undefined) {
    const ids = hexList(rec.ids, MAX_FILTER_IDS, "ids");
    if ("error" in ids) return ids;
    f.ids = ids.values;
  }
  if (rec.authors !== undefined) {
    const authors = hexList(rec.authors, MAX_FILTER_AUTHORS, "authors");
    if ("error" in authors) return authors;
    f.authors = authors.values;
  }
  if (rec.kinds !== undefined) {
    const kinds = rec.kinds;
    if (
      !Array.isArray(kinds) ||
      kinds.length === 0 ||
      kinds.length > MAX_FILTER_KINDS
    ) {
      return { error: `kinds must be a non-empty list of at most ${MAX_FILTER_KINDS} kinds` };
    }
    for (const k of kinds) {
      if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k > 65535) {
        return { error: "kinds must be integers in 0-65535" };
      }
    }
    f.kinds = kinds as number[];
  }
  if (rec.since !== undefined) {
    if (!isTimestamp(rec.since)) return { error: "since must be a unix timestamp" };
    f.since = rec.since;
  }
  if (rec.until !== undefined) {
    if (!isTimestamp(rec.until)) return { error: "until must be a unix timestamp" };
    f.until = rec.until;
  }
  if (rec.limit !== undefined) {
    if (typeof rec.limit !== "number" || !Number.isInteger(rec.limit)) {
      return { error: "limit must be an integer" };
    }
    f.limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, rec.limit));
  }

  // Tag filters: `#d` → dTags (SQL-translated downstream); other single-
  // letter keys → tagFilters (JS-post-filtered). Anything else is ignored.
  for (const key of Object.keys(rec)) {
    const m = TAG_FILTER_KEY.exec(key);
    if (m === null) continue;
    const letter = m[1] as string; // regex has exactly one capture group
    const values = stringList(rec[key], MAX_TAG_FILTER_VALUES, key);
    if ("error" in values) return values;
    if (letter === "d") {
      f.dTags = values.values;
    } else {
      (f.tagFilters ??= {})[letter] = values.values;
    }
  }

  return f;
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function hexList(
  value: unknown,
  max: number,
  name: string,
): { values: string[] } | ErrorResult {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    return { error: `${name} must be a non-empty list of at most ${max} values` };
  }
  for (const v of value) {
    if (typeof v !== "string" || !HEX_64.test(v)) {
      return { error: `${name} must contain 64-char lowercase hex values` };
    }
  }
  return { values: value as string[] };
}

function stringList(
  value: unknown,
  max: number,
  name: string,
): { values: string[] } | ErrorResult {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    return { error: `${name} must be a non-empty list of at most ${max} values` };
  }
  for (const v of value) {
    // Values longer than an event tag item can ever be (MAX_TAG_ITEM_LENGTH)
    // can never match anything — reject instead of persisting dead weight in
    // DO SQLite subs rows.
    if (typeof v !== "string" || v.length > MAX_TAG_ITEM_LENGTH) {
      return { error: `${name} values must be strings of at most ${MAX_TAG_ITEM_LENGTH} chars` };
    }
  }
  return { values: value as string[] };
}

// --- Matching (live fan-out) -----------------------------------------------------

/**
 * The `d` value the store slots this event under: parameterized-replaceable
 * kinds (30000-39999) key on their FIRST `d` tag, every other kind (0/5/…)
 * occupies the empty-string slot even when a stray `d` tag is present. Mirrors
 * mirror.ts `slotDTag` so live `#d` matching and the indexed `d_tag` column
 * (query.ts) can never disagree — otherwise a kind-5-with-stray-d or a
 * multi-`d` 30023 could be live-fanned to a `#d` subscriber while a fresh REQ
 * returns nothing.
 */
function slottedDTag(ev: NostrEvent): string {
  return ev.kind >= 30_000 && ev.kind < 40_000 ? getDTag(ev) : "";
}

/**
 * Does one sanitized filter match an event? All present conditions must hold
 * (NIP-01 AND semantics within a filter); `limit` is a query cap, not a
 * match condition. `#d` matches the event's SLOTTED `d` value (see
 * slottedDTag — mirrors the SQL `d_tag` column); generic tag conditions match
 * when ANY tag of that name carries one of the requested values.
 */
export function matchEvent(f: SanitizedFilter, ev: NostrEvent): boolean {
  if (f.ids !== undefined && !f.ids.includes(ev.id)) return false;
  if (f.authors !== undefined && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds !== undefined && !f.kinds.includes(ev.kind)) return false;
  if (f.since !== undefined && ev.created_at < f.since) return false;
  if (f.until !== undefined && ev.created_at > f.until) return false;
  if (f.dTags !== undefined && !f.dTags.includes(slottedDTag(ev))) return false;
  if (f.tagFilters !== undefined) {
    for (const [letter, values] of Object.entries(f.tagFilters)) {
      if (!hasTagValue(ev, letter, values)) return false;
    }
  }
  return true;
}

/** An event matches a REQ when ANY of its filters match (NIP-01 OR). */
export function matchesAnyFilter(
  filters: SanitizedFilter[],
  ev: NostrEvent,
): boolean {
  return filters.some((f) => matchEvent(f, ev));
}

/** Does the event carry a tag `[name, v]` with v in `values`? */
function hasTagValue(ev: NostrEvent, name: string, values: string[]): boolean {
  return ev.tags.some((t) => {
    if (t[0] !== name) return false;
    const v = t[1];
    return v !== undefined && values.includes(v);
  });
}
