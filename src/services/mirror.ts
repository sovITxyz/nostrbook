import {
  getDTag,
  pickEventFields,
  verifyEvent,
  type NostrEvent,
} from "../nostr/event";
import { renderPost } from "../markdown";
import { postMeta } from "../markdown/nip23";
import { upsertProfile } from "./profiles";

export type MirrorResult = "stored" | "stale" | "invalid";

/** Options for mirrorEvent / applyDelete. */
export type MirrorOptions = {
  /**
   * Bump the KV cache generation after a stored change (default true, the
   * contract behavior). Multi-event ingest sessions (cron refresh, npub
   * on-demand mirror) pass `false` and call bumpGen ONCE per touched pubkey
   * afterwards — the KV free tier allows only 1,000 writes/day, so mirroring
   * N events must not cost N puts.
   */
  bumpGen?: boolean;
};

const HEX_64 = /^[0-9a-f]{64}$/;

/** Current cache generation for a pubkey ("0" when never bumped). */
export async function getGen(env: Env, pubkey: string): Promise<string> {
  return (await env.KV.get(`gen:${pubkey}`)) ?? "0";
}

/**
 * Bump the KV cache generation for a pubkey. Every stored mirror change
 * (post, profile, delete) invalidates that blog's edge cache by changing the
 * `?g=<gen>` component of its cache keys (src/middleware/cache.ts).
 *
 * The value is a unique opaque string, NOT a counter: the cache middleware
 * only ever compares generations for equality, and the previous
 * get→parseInt→put read-modify-write let two concurrent bumps write the same
 * next value — collapsing two invalidations into one and pinning a stale
 * page until its TTL. One KV write, no read.
 */
export async function bumpGen(env: Env, pubkey: string): Promise<void> {
  const gen = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  await env.KV.put(`gen:${pubkey}`, gen);
}

/**
 * Slot d_tag per NIP-01: only parameterized-replaceable kinds (30000-39999)
 * are keyed by their `d` tag. Every other kind (0, 5, ...) occupies the
 * (pubkey, kind, '') slot even when a client attached a stray d tag —
 * otherwise two kind-0 rows could coexist and the older would never be
 * replaced.
 */
function slotDTag(ev: NostrEvent): string {
  return ev.kind >= 30_000 && ev.kind < 40_000 ? getDTag(ev) : "";
}

/** True when `err` looks like a D1/SQLite uniqueness-constraint violation. */
function isConstraintError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}`
      : String(err);
  return /UNIQUE constraint|SQLITE_CONSTRAINT|constraint failed/i.test(msg);
}

/** Row subset used for replaceable-slot comparisons. */
type SlotRow = { row_id: number; id: string; created_at: number };

async function currentSlot(
  env: Env,
  pubkey: string,
  kind: number,
  dTag: string,
): Promise<SlotRow | null> {
  const row = await env.DB.prepare(
    `SELECT rowid AS row_id, id, created_at FROM events
     WHERE pubkey = ? AND kind = ? AND d_tag = ?`,
  )
    .bind(pubkey, kind, dTag)
    .first<SlotRow>();
  return row ?? null;
}

/**
 * NIP-01 replaceable ordering: does `incoming` lose against the currently
 * stored event for the same (pubkey, kind, d_tag)? Greater created_at wins;
 * ties break to the lexicographically LOWER id (equal id means it IS the
 * stored event, which the id short-circuit already handled).
 */
function losesToCurrent(current: SlotRow, incoming: NostrEvent): boolean {
  if (current.created_at !== incoming.created_at) {
    return current.created_at > incoming.created_at;
  }
  return current.id <= incoming.id;
}

/**
 * Mirror a Nostr event into D1.
 *
 * Contract (docs/phases/CONTRACTS.md): verify → replaceable upsert per
 * (pubkey, kind, d_tag), newest created_at wins, ties broken by lower id →
 * kind 5 delete handling (same-pubkey references only) → render-at-ingest
 * for kind 30023 (events.rendered) → posts_fts maintenance (rowid =
 * events.rowid) → KV gen bump. Verification is skipped for event ids that
 * are already stored (the id is the sha256 of the content, so an id match
 * with the previously verified row means identical content).
 */
export async function mirrorEvent(
  env: Env,
  ev: NostrEvent,
  opts?: MirrorOptions,
): Promise<MirrorResult> {
  // Already mirrored? The stored row was verified when it was stored; a
  // matching id means byte-identical content, so skip crypto entirely when
  // the sig also matches. A different sig on the same id is unusual (schnorr
  // sigs are not unique) — verify it, then keep the existing row either way.
  const prior = await env.DB.prepare("SELECT sig FROM events WHERE id = ?")
    .bind(ev.id)
    .first<{ sig: string }>();
  if (prior) {
    if (prior.sig === ev.sig) return "stored";
    return (await verifyEvent(ev)) ? "stored" : "invalid";
  }

  if (!(await verifyEvent(ev))) return "invalid";

  if (ev.kind === 5) return applyDelete(env, ev, opts);

  const dTag = slotDTag(ev);

  // Render-at-ingest (contract addendum): renderPost+sanitize exactly once,
  // here; the request path serves the stored HTML.
  const rendered = ev.kind === 30023 ? renderPost(ev.content) : null;

  // NIP-09 delete horizon: a stored kind 5 whose `a` tag addresses this
  // (kind:pubkey:d_tag) with created_at >= this version's created_at deletes
  // it even when the version ARRIVES after the delete was mirrored —
  // otherwise an intermediate edit (created before the delete, delivered
  // late by a relay) would resurrect a deleted post.
  const tombstoned =
    ev.kind === 30023 && (await coveredByDeleteHorizon(env, ev, dTag));

  // The slot read below and the batch are not atomic: a concurrent mirror of
  // the same id or slot can commit in between, making this batch trip the
  // events PRIMARY KEY / UNIQUE(pubkey, kind, d_tag) constraint. Re-read and
  // reclassify instead of surfacing a 500 — one bounded retry.
  for (let attempt = 0; ; attempt++) {
    const current = await currentSlot(env, ev.pubkey, ev.kind, dTag);
    if (current && losesToCurrent(current, ev)) return "stale";

    const stmts: D1PreparedStatement[] = [];
    if (current) {
      // Replace: drop the losing row AND its FTS row (rowid-coupled).
      stmts.push(
        env.DB.prepare("DELETE FROM posts_fts WHERE rowid = ?").bind(
          current.row_id,
        ),
        env.DB.prepare("DELETE FROM events WHERE rowid = ?").bind(
          current.row_id,
        ),
      );
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO events (id, pubkey, kind, d_tag, created_at, content, tags, sig, raw, deleted, rendered)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        ev.id,
        ev.pubkey,
        ev.kind,
        dTag,
        ev.created_at,
        ev.content,
        JSON.stringify(ev.tags),
        ev.sig,
        JSON.stringify(pickEventFields(ev)),
        tombstoned ? 1 : 0,
        rendered,
      ),
    );
    if (ev.kind === 30023 && !tombstoned) {
      // FTS row with rowid = events.rowid, resolved inside the same atomic
      // batch via INSERT...SELECT (the rowid does not exist before the insert).
      const meta = postMeta(ev);
      stmts.push(
        env.DB.prepare(
          `INSERT INTO posts_fts (rowid, title, summary, content)
           SELECT rowid, ?, ?, ? FROM events WHERE id = ?`,
        ).bind(meta.title, meta.summary ?? "", ev.content, ev.id),
      );
    }
    try {
      await env.DB.batch(stmts); // D1 batch runs as a single transaction
      break;
    } catch (err) {
      if (attempt > 0 || !isConstraintError(err)) throw err;
      // Raced by a concurrent mirror. If it stored this exact id, the work
      // is done (identical content); otherwise retry once with a fresh slot.
      const raced = await env.DB.prepare("SELECT 1 FROM events WHERE id = ?")
        .bind(ev.id)
        .first();
      if (raced) return "stored";
    }
  }

  if (ev.kind === 0) await upsertProfile(env, ev);
  if (opts?.bumpGen !== false) await bumpGen(env, ev.pubkey);
  return "stored";
}

/**
 * Does a stored kind 5 of the same pubkey delete this (kind, pubkey, d_tag)
 * address at or after `ev.created_at`? One row per (pubkey, 5, d_tag) slot
 * exists at most, so this scan is cheap. Known limitation (schema-imposed):
 * a newer delete REPLACES an older one in the same slot, so an old delete's
 * horizon survives only as long as its marker row does.
 */
async function coveredByDeleteHorizon(
  env: Env,
  ev: NostrEvent,
  dTag: string,
): Promise<boolean> {
  const addr = `${ev.kind}:${ev.pubkey}:${dTag}`;
  const rs = await env.DB.prepare(
    "SELECT tags FROM events WHERE pubkey = ? AND kind = 5 AND created_at >= ?",
  )
    .bind(ev.pubkey, ev.created_at)
    .all<{ tags: string }>();
  for (const row of rs.results) {
    try {
      const tags: unknown = JSON.parse(row.tags);
      if (!Array.isArray(tags)) continue;
      for (const tag of tags) {
        if (Array.isArray(tag) && tag[0] === "a" && tag[1] === addr) {
          return true;
        }
      }
    } catch {
      // malformed tags blob — ignore this marker
    }
  }
  return false;
}

/**
 * Kind 5 (NIP-09) delete handling. Marks referenced events `deleted = 1`
 * ONLY when they belong to the deleting pubkey:
 *   - `e` tags: by exact event id (must still be owned by ev.pubkey);
 *   - `a` tags: `kind:pubkey:d_tag` addresses whose embedded pubkey equals
 *     ev.pubkey, limited to versions with created_at <= the delete's
 *     created_at (NIP-09: a later republish supersedes the delete).
 * FTS rows of hidden posts are removed. The kind 5 event itself is stored in
 * its (pubkey, 5, d_tag) slot when it is the newest there — but its side
 * effects apply regardless (deletions are not replaceable; an older second
 * delete must still hide its own targets).
 */
async function applyDelete(
  env: Env,
  ev: NostrEvent,
  opts?: MirrorOptions,
): Promise<MirrorResult> {
  const eIds: string[] = [];
  const addrs: { kind: number; dTag: string }[] = [];
  for (const tag of ev.tags) {
    if (tag[0] === "e" && typeof tag[1] === "string" && HEX_64.test(tag[1])) {
      eIds.push(tag[1]);
    } else if (tag[0] === "a" && typeof tag[1] === "string") {
      const m = /^(\d{1,5}):([0-9a-f]{64}):([\s\S]*)$/.exec(tag[1]);
      if (m && m[2] === ev.pubkey) {
        addrs.push({ kind: Number(m[1]), dTag: m[3] ?? "" });
      }
    }
  }

  // Kind 5 is not parameterized-replaceable, so its marker always lives in
  // the (pubkey, 5, '') slot regardless of stray d tags.
  const dTag = slotDTag(ev);

  // Same check-then-write race as the main store path: retry once when a
  // concurrent mirror trips the id/slot uniqueness constraints (the batch is
  // atomic, so the deleted=1 side effects roll back with it and re-run).
  for (let attempt = 0; ; attempt++) {
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < eIds.length; i += 50) {
      const chunk = eIds.slice(i, i + 50);
      const placeholders = chunk.map(() => "?").join(", ");
      stmts.push(
        env.DB.prepare(
          `UPDATE events SET deleted = 1
           WHERE pubkey = ? AND kind != 5 AND id IN (${placeholders})`,
        ).bind(ev.pubkey, ...chunk),
      );
    }
    for (const a of addrs) {
      stmts.push(
        env.DB.prepare(
          `UPDATE events SET deleted = 1
           WHERE pubkey = ? AND kind = ? AND d_tag = ? AND kind != 5
             AND created_at <= ?`,
        ).bind(ev.pubkey, a.kind, a.dTag, ev.created_at),
      );
    }
    // Hidden posts leave the search index.
    stmts.push(
      env.DB.prepare(
        `DELETE FROM posts_fts WHERE rowid IN
           (SELECT rowid FROM events WHERE pubkey = ? AND deleted = 1)`,
      ).bind(ev.pubkey),
    );

    // Store the delete marker itself when it is the newest in its slot (the
    // UNIQUE(pubkey, kind, d_tag) schema allows only one row per slot).
    const current = await currentSlot(env, ev.pubkey, 5, dTag);
    if (!current || !losesToCurrent(current, ev)) {
      if (current) {
        stmts.push(
          env.DB.prepare("DELETE FROM events WHERE rowid = ?").bind(
            current.row_id,
          ),
        );
      }
      stmts.push(
        env.DB.prepare(
          `INSERT INTO events (id, pubkey, kind, d_tag, created_at, content, tags, sig, raw, deleted, rendered)
           VALUES (?, ?, 5, ?, ?, ?, ?, ?, ?, 0, NULL)`,
        ).bind(
          ev.id,
          ev.pubkey,
          dTag,
          ev.created_at,
          ev.content,
          JSON.stringify(ev.tags),
          ev.sig,
          JSON.stringify(pickEventFields(ev)),
        ),
      );
    }

    try {
      await env.DB.batch(stmts);
      break;
    } catch (err) {
      if (attempt > 0 || !isConstraintError(err)) throw err;
      // Raced by a concurrent mirror of this same delete: its batch already
      // applied identical side effects.
      const raced = await env.DB.prepare("SELECT 1 FROM events WHERE id = ?")
        .bind(ev.id)
        .first();
      if (raced) break;
    }
  }

  if (opts?.bumpGen !== false) await bumpGen(env, ev.pubkey);
  return "stored";
}
