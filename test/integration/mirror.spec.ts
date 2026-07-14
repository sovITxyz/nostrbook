// mirrorEvent invariants proven against real D1: verify gate, replaceable
// upsert (newest wins, lower-id tie-break), kind 5 delete handling (same
// pubkey only), render-at-ingest, posts_fts lifecycle, KV gen bumps.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/events.json";
import { resetMirrorState } from "../helpers";
import { mirrorEvent } from "../../src/services/mirror";
import { getProfile } from "../../src/services/profiles";
import type { NostrEvent } from "../../src/nostr/event";

// Storage persists across tests in this file; every test starts clean so
// row counts and gen counters are exact.
beforeEach(async () => {
  await resetMirrorState();
});

const aliceProfile = fixtures.profiles.alice as NostrEvent;
const aliceProfileOld = fixtures.extras.aliceProfileOld as NostrEvent;
const aliceProfileDTag = fixtures.extras.aliceProfileDTag as NostrEvent;
const aliceHello = fixtures.posts.aliceHello as NostrEvent;
const aliceHelloEdit = fixtures.extras.aliceHelloEdit as NostrEvent;
const stale = fixtures.replaceable.stale as NostrEvent;
const newer = fixtures.replaceable.newer as NostrEvent;
const deleteByAlice = fixtures.delete as NostrEvent;
const deleteByMallory = fixtures.extras.deleteByMallory as NostrEvent;
const tieA = fixtures.extras.tie.a as NostrEvent;
const tieB = fixtures.extras.tie.b as NostrEvent;
const tampered = fixtures.tampered as { reason: string; event: NostrEvent }[];

type EventsRow = {
  row_id: number;
  id: string;
  kind: number;
  d_tag: string;
  created_at: number;
  content: string;
  deleted: number;
  rendered: string | null;
};

async function rowById(id: string): Promise<EventsRow | null> {
  return (
    (await env.DB.prepare(
      "SELECT rowid AS row_id, id, kind, d_tag, created_at, content, deleted, rendered FROM events WHERE id = ?",
    )
      .bind(id)
      .first<EventsRow>()) ?? null
  );
}

async function slotRows(
  pubkey: string,
  kind: number,
  dTag: string,
): Promise<EventsRow[]> {
  const rs = await env.DB.prepare(
    "SELECT rowid AS row_id, id, kind, d_tag, created_at, content, deleted, rendered FROM events WHERE pubkey = ? AND kind = ? AND d_tag = ?",
  )
    .bind(pubkey, kind, dTag)
    .all<EventsRow>();
  return rs.results;
}

async function ftsRowids(match: string): Promise<number[]> {
  const rs = await env.DB.prepare(
    "SELECT rowid AS row_id FROM posts_fts WHERE posts_fts MATCH ?",
  )
    .bind(match)
    .all<{ row_id: number }>();
  return rs.results.map((r) => r.row_id);
}

async function gen(pubkey: string): Promise<string | null> {
  return env.KV.get(`gen:${pubkey}`);
}

describe("mirrorEvent — store + render-at-ingest", () => {
  it("stores a valid 30023 with rendered HTML, FTS row, and a gen bump", async () => {
    expect(await mirrorEvent(env, aliceHello)).toBe("stored");

    const row = await rowById(aliceHello.id);
    expect(row).not.toBeNull();
    expect(row!.kind).toBe(30023);
    expect(row!.d_tag).toBe("hello-world");
    expect(row!.deleted).toBe(0);
    // renderPost+sanitize ran at ingest and the HTML is stored:
    expect(row!.rendered).toContain("<strong>alice</strong>");
    expect(row!.rendered!.toLowerCase()).not.toContain("<script");

    // FTS row exists with rowid = events.rowid:
    expect(await ftsRowids("hello")).toContain(row!.row_id);

    // Gen values are opaque unique strings; storing must set one.
    expect(await gen(aliceHello.pubkey)).not.toBeNull();
  });

  it("is idempotent for an already-stored id (no duplicate, no extra gen bump)", async () => {
    expect(await mirrorEvent(env, aliceHello)).toBe("stored");
    const g1 = await gen(aliceHello.pubkey);
    expect(g1).not.toBeNull();
    expect(await mirrorEvent(env, aliceHello)).toBe("stored");
    const rows = await slotRows(aliceHello.pubkey, 30023, "hello-world");
    expect(rows.length).toBe(1);
    expect(await gen(aliceHello.pubkey)).toBe(g1); // no extra bump
  });

  it("stores kind 0 into events AND upserts the profiles row", async () => {
    expect(await mirrorEvent(env, aliceProfile)).toBe("stored");
    const rows = await slotRows(aliceProfile.pubkey, 0, "");
    expect(rows.length).toBe(1);
    expect(rows[0]!.rendered).toBeNull(); // only 30023 rows are rendered
    const profile = await getProfile(env, aliceProfile.pubkey);
    expect(profile?.name).toBe("alice-test");
    expect(profile?.nip05).toBe("alice@nbread.lol");
  });
});

describe("mirrorEvent — verification gate", () => {
  for (const { reason, event } of tampered) {
    it(`rejects tampered event (${reason}) and stores nothing`, async () => {
      expect(await mirrorEvent(env, event)).toBe("invalid");
      expect(await rowById(event.id)).toBeNull();
      expect(await gen(event.pubkey)).toBeNull();
    });
  }
});

describe("mirrorEvent — replaceable upsert", () => {
  it("returns 'stale' and never overwrites when an older version arrives", async () => {
    expect(await mirrorEvent(env, newer)).toBe("stored");
    const g1 = await gen(newer.pubkey);
    expect(await mirrorEvent(env, stale)).toBe("stale");

    const rows = await slotRows(newer.pubkey, 30023, "replaceable");
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(newer.id);
    expect(rows[0]!.content).toContain("Version 2");
    // The stale version never reached the search index:
    expect(await ftsRowids("lose")).toEqual([]);
    // The stale mirror must not move the generation (no cache invalidation):
    expect(await gen(newer.pubkey)).toBe(g1);
  });

  it("replaces an older version and keeps posts_fts in sync (rowid-coupled)", async () => {
    expect(await mirrorEvent(env, stale)).toBe("stored");
    const staleRow = await rowById(stale.id);
    expect(await ftsRowids("lose")).toContain(staleRow!.row_id);

    expect(await mirrorEvent(env, newer)).toBe("stored");
    const rows = await slotRows(newer.pubkey, 30023, "replaceable");
    expect(rows.length).toBe(1); // UNIQUE(pubkey, kind, d_tag) invariant
    expect(rows[0]!.id).toBe(newer.id);

    // Old FTS row is gone, new one is present and rowid-coupled:
    expect(await ftsRowids("lose")).toEqual([]);
    expect(await ftsRowids("win")).toContain(rows[0]!.row_id);
  });

  it("tie-break: the lexicographically lower id replaces a higher one", async () => {
    const lo = tieA.id < tieB.id ? tieA : tieB;
    const hi = tieA.id < tieB.id ? tieB : tieA;
    expect(lo.created_at).toBe(hi.created_at);

    expect(await mirrorEvent(env, hi)).toBe("stored");
    expect(await mirrorEvent(env, lo)).toBe("stored"); // lower id wins the tie
    const rows = await slotRows(lo.pubkey, 30023, "tie-break");
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(lo.id);
  });

  it("tie-break: a higher id arriving second is stale", async () => {
    const lo = tieA.id < tieB.id ? tieA : tieB;
    const hi = tieA.id < tieB.id ? tieB : tieA;

    expect(await mirrorEvent(env, lo)).toBe("stored");
    expect(await mirrorEvent(env, hi)).toBe("stale");
    const rows = await slotRows(lo.pubkey, 30023, "tie-break");
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(lo.id);
  });

  it("keeps the newest profile when an older kind 0 arrives later", async () => {
    expect(await mirrorEvent(env, aliceProfile)).toBe("stored");
    expect(await mirrorEvent(env, aliceProfileOld)).toBe("stale");
    const profile = await getProfile(env, aliceProfile.pubkey);
    expect(profile?.name).toBe("alice-test");
    const rows = await slotRows(aliceProfile.pubkey, 0, "");
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(aliceProfile.id);
  });

  it("upgrades the profile when the newer kind 0 arrives second", async () => {
    expect(await mirrorEvent(env, aliceProfileOld)).toBe("stored");
    expect((await getProfile(env, aliceProfile.pubkey))?.name).toBe(
      "alice-old",
    );
    expect(await mirrorEvent(env, aliceProfile)).toBe("stored");
    expect((await getProfile(env, aliceProfile.pubkey))?.name).toBe(
      "alice-test",
    );
  });

  it("ignores stray d tags on kind 0 — the slot is always (pubkey, 0, '')", async () => {
    expect(await mirrorEvent(env, aliceProfile)).toBe("stored"); // T0, no d tag
    expect(await mirrorEvent(env, aliceProfileDTag)).toBe("stored"); // T0+10, stray d tag

    // The newer kind 0 REPLACED the older one in the '' slot — no second row
    // parked under the stray d tag where it would never be replaced:
    const rows = await slotRows(aliceProfile.pubkey, 0, "");
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(aliceProfileDTag.id);
    expect((await slotRows(aliceProfile.pubkey, 0, "stray-d-tag")).length).toBe(
      0,
    );
    expect((await getProfile(env, aliceProfile.pubkey))?.name).toBe(
      "alice-dtag",
    );
  });
});

describe("mirrorEvent — kind 5 deletes", () => {
  it("marks the signer's referenced events deleted and drops their FTS rows", async () => {
    expect(await mirrorEvent(env, aliceHello)).toBe("stored");
    const before = await rowById(aliceHello.id);
    expect(await ftsRowids("hello")).toContain(before!.row_id);
    const g1 = await gen(aliceHello.pubkey);

    expect(await mirrorEvent(env, deleteByAlice)).toBe("stored");

    const after = await rowById(aliceHello.id);
    expect(after!.deleted).toBe(1);
    expect(await ftsRowids("hello")).toEqual([]);
    // The delete marker itself is mirrored:
    expect(await rowById(deleteByAlice.id)).not.toBeNull();
    // Deletion invalidates the blog's cache (generation moved):
    const g2 = await gen(aliceHello.pubkey);
    expect(g2).not.toBeNull();
    expect(g2).not.toBe(g1);
  });

  it("NEVER deletes another pubkey's events (mallory referencing alice)", async () => {
    expect(await mirrorEvent(env, aliceHello)).toBe("stored");
    const gAlice = await gen(aliceHello.pubkey);
    expect(await mirrorEvent(env, deleteByMallory)).toBe("stored");

    const row = await rowById(aliceHello.id);
    expect(row!.deleted).toBe(0); // untouched
    expect(await ftsRowids("hello")).toContain(row!.row_id);
    // alice's cache generation did not move — only mallory's:
    expect(await gen(aliceHello.pubkey)).toBe(gAlice);
    expect(await gen(deleteByMallory.pubkey)).not.toBeNull();
  });

  it("does not resurrect a deleted post when an intermediate edit arrives late (NIP-09 horizon)", async () => {
    // v1 (T0+100) stored, then deleted (kind 5 at T0+700 with a-tag):
    expect(await mirrorEvent(env, aliceHello)).toBe("stored");
    expect(await mirrorEvent(env, deleteByAlice)).toBe("stored");

    // An edit created BEFORE the delete (T0+650) arrives AFTER it. It wins
    // the replaceable slot (newer than v1) but must stay hidden — the stored
    // delete's created_at covers it.
    expect(await mirrorEvent(env, aliceHelloEdit)).toBe("stored");

    const rows = await slotRows(aliceHello.pubkey, 30023, "hello-world");
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(aliceHelloEdit.id);
    expect(rows[0]!.deleted).toBe(1); // tombstone horizon holds
    // ...and it never entered the search index:
    expect(await ftsRowids("edited")).toEqual([]);
  });
});
