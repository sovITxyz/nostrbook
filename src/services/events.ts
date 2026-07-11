import type { NostrEvent } from "../nostr/event";

/** Row shape of the `events` table (rendered added by migration 0002). */
export type EventRow = {
  id: string;
  pubkey: string;
  kind: number;
  d_tag: string;
  created_at: number;
  content: string;
  tags: string; // JSON string[][]
  sig: string;
  raw: string; // canonical original event JSON
  deleted: number; // 0 | 1
  rendered: string | null; // sanitized HTML, kind 30023 rows only
};

/** Default page size for blog post lists (home, feeds, sitemap). */
export const DEFAULT_POST_LIMIT = 100;

/** List mirrored, non-deleted kind-30023 posts for a pubkey, newest first. */
export async function listPostsByPubkey(
  env: Env,
  pubkey: string,
  limit: number = DEFAULT_POST_LIMIT,
): Promise<EventRow[]> {
  const rs = await env.DB.prepare(
    `SELECT * FROM events
     WHERE pubkey = ? AND kind = 30023 AND deleted = 0
     ORDER BY created_at DESC, id ASC
     LIMIT ?`,
  )
    .bind(pubkey, limit)
    .all<EventRow>();
  return rs.results;
}

/** Get a single non-deleted post by (pubkey, d_tag), or null. */
export async function getPost(
  env: Env,
  pubkey: string,
  dTag: string,
): Promise<EventRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM events
     WHERE pubkey = ? AND kind = 30023 AND d_tag = ? AND deleted = 0`,
  )
    .bind(pubkey, dTag)
    .first<EventRow>();
  return row ?? null;
}

/**
 * Parse an events row back into a NostrEvent. The tags column was written by
 * mirrorEvent from a verified event, but parse defensively anyway: a
 * malformed blob degrades to `tags: []` instead of throwing on the render
 * path.
 */
export function rowToEvent(row: EventRow): NostrEvent {
  let tags: string[][] = [];
  try {
    const parsed: unknown = JSON.parse(row.tags);
    if (Array.isArray(parsed)) {
      tags = parsed.filter(
        (t): t is string[] =>
          Array.isArray(t) && t.every((item) => typeof item === "string"),
      );
    }
  } catch {
    // malformed tags blob → no tags
  }
  return {
    id: row.id,
    pubkey: row.pubkey,
    kind: row.kind,
    created_at: row.created_at,
    tags,
    content: row.content,
    sig: row.sig,
  };
}

// D1 caps bound parameters per statement (~100); stay well under it.
const ID_CHUNK = 50;

/**
 * Which of `ids` are already mirrored. Used by ingest paths (cron refresh,
 * npub on-demand mirror) to skip already-stored events WITHOUT spending a
 * verification credit on them.
 */
export async function storedEventIds(
  env: Env,
  ids: string[],
): Promise<Set<string>> {
  const stored = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rs = await env.DB.prepare(
      `SELECT id FROM events WHERE id IN (${placeholders})`,
    )
      .bind(...chunk)
      .all<{ id: string }>();
    for (const row of rs.results) stored.add(row.id);
  }
  return stored;
}

/** Oldest mirrored created_at for a pubkey (any kind), or null when none. */
export async function oldestCreatedAt(
  env: Env,
  pubkey: string,
): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT MIN(created_at) AS m FROM events WHERE pubkey = ?",
  )
    .bind(pubkey)
    .first<{ m: number | null }>();
  return row?.m ?? null;
}
