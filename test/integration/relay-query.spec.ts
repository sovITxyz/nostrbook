// Relay REQ query engine against the real (miniflare) D1: events seeded
// through mirrorEvent — replaceable semantics, NIP-09 tombstones and the raw
// column are exactly what production writes — then read back via queryEvents.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";
import {
  ALICE_PK,
  ALICE_SK,
  BOB_PK,
  BOB_SK,
  resetMirrorState,
} from "../helpers";
import { mirrorEvent } from "../../src/services/mirror";
import { queryEvents } from "../../src/relay/query";
import type { SanitizedFilter } from "../../src/relay/types";
import type { NostrEvent } from "../../src/nostr/event";

/** Sign an arbitrary event with a committed throwaway fixture key. */
function sign(
  sk: string,
  opts: {
    kind: number;
    created_at: number;
    tags?: string[][];
    content?: string;
  },
): NostrEvent {
  return finalizeEvent(
    {
      kind: opts.kind,
      created_at: opts.created_at,
      tags: opts.tags ?? [],
      content: opts.content ?? "",
    },
    hexToBytes(sk),
  ) as NostrEvent;
}

/** 30023 with the editor's tag shape plus optional extra tags (#t etc.). */
function post(
  sk: string,
  d: string,
  created_at: number,
  extraTags: string[][] = [],
  content = `body of ${d}`,
): NostrEvent {
  return sign(sk, {
    kind: 30023,
    created_at,
    tags: [["d", d], ["title", d], ...extraTags],
    content,
  });
}

/** SanitizedFilter with the sanitizer's default limit applied. */
function filter(partial: Partial<SanitizedFilter> = {}): SanitizedFilter {
  return { limit: 100, ...partial };
}

// Base corpus (mirrored fresh in beforeEach):
//   alice a1 @1000, a2 @2000 (#t nostr), a3 @3000
//   bob   b1 @2500 (#t bread)
//   alice profile (kind 0) @1500
const aliceA1 = post(ALICE_SK, "a1", 1000);
const aliceA2 = post(ALICE_SK, "a2", 2000, [["t", "nostr"]]);
const aliceA3 = post(ALICE_SK, "a3", 3000);
const bobB1 = post(BOB_SK, "b1", 2500, [["t", "bread"]]);
const aliceProfile = sign(ALICE_SK, {
  kind: 0,
  created_at: 1500,
  content: JSON.stringify({ name: "alice-relay-test" }),
});
const CORPUS = [aliceA1, aliceA2, aliceA3, bobB1, aliceProfile];

describe("relay query engine (queryEvents over mirrored D1 events)", () => {
  beforeEach(async () => {
    await resetMirrorState();
    for (const ev of CORPUS) {
      expect(await mirrorEvent(env, ev)).toBe("stored");
    }
  });

  it("migration 0005 created idx_events_author_time on events", async () => {
    const row = await env.DB.prepare(
      `SELECT name, tbl_name FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_events_author_time'`,
    ).first<{ name: string; tbl_name: string }>();
    expect(row).not.toBeNull();
    expect(row!.tbl_name).toBe("events");
  });

  it("orders created_at DESC and serves the canonical stored raw JSON", async () => {
    const rows = await queryEvents(env, [filter({ kinds: [30023] })]);
    expect(rows.map((r) => r.id)).toEqual([
      aliceA3.id,
      bobB1.id,
      aliceA2.id,
      aliceA1.id,
    ]);
    // raw is servable as-is: parses back to the signed event.
    const parsed = JSON.parse(rows[0]!.raw) as NostrEvent;
    expect(parsed.id).toBe(aliceA3.id);
    expect(parsed.sig).toBe(aliceA3.sig);
    expect(parsed.content).toBe(aliceA3.content);
  });

  it("breaks created_at ties by id ASC", async () => {
    const twinA = post(ALICE_SK, "twin-a", 5000);
    const twinB = post(ALICE_SK, "twin-b", 5000);
    for (const ev of [twinA, twinB]) {
      expect(await mirrorEvent(env, ev)).toBe("stored");
    }
    const rows = await queryEvents(env, [
      filter({ authors: [ALICE_PK], since: 5000 }),
    ]);
    const expected = [twinA.id, twinB.id].sort();
    expect(rows.map((r) => r.id)).toEqual(expected);
  });

  it("filters by ids", async () => {
    const rows = await queryEvents(env, [
      filter({ ids: [aliceA1.id, bobB1.id] }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([bobB1.id, aliceA1.id]);
  });

  it("filters by authors", async () => {
    const rows = await queryEvents(env, [
      filter({ authors: [BOB_PK], kinds: [30023] }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([bobB1.id]);
  });

  it("filters by kinds (kind 0 profile only via kinds:[0])", async () => {
    const rows = await queryEvents(env, [filter({ kinds: [0] })]);
    expect(rows.map((r) => r.id)).toEqual([aliceProfile.id]);
    // and kinds:[30023] never leaks the profile
    const posts = await queryEvents(env, [filter({ kinds: [30023] })]);
    expect(posts.map((r) => r.id)).not.toContain(aliceProfile.id);
  });

  it("applies since/until inclusively", async () => {
    const rows = await queryEvents(env, [
      filter({ kinds: [30023], since: 2000, until: 2500 }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([bobB1.id, aliceA2.id]);
  });

  it("filters by #d via the indexed d_tag column", async () => {
    const rows = await queryEvents(env, [
      filter({ kinds: [30023], dTags: ["a2", "b1"] }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([bobB1.id, aliceA2.id]);
  });

  it("post-filters generic tag filters (#t) in JS from row.raw", async () => {
    const rows = await queryEvents(env, [
      filter({ kinds: [30023], tagFilters: { t: ["nostr"] } }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([aliceA2.id]);
    // tolerant of the "#t" key spelling too
    const hashRows = await queryEvents(env, [
      filter({ kinds: [30023], tagFilters: { "#t": ["bread"] } }),
    ]);
    expect(hashRows.map((r) => r.id)).toEqual([bobB1.id]);
    // no match -> empty
    const none = await queryEvents(env, [
      filter({ kinds: [30023], tagFilters: { t: ["absent-topic"] } }),
    ]);
    expect(none).toEqual([]);
  });

  it("enforces the per-filter limit (newest first)", async () => {
    const rows = await queryEvents(env, [filter({ kinds: [30023], limit: 2 })]);
    expect(rows.map((r) => r.id)).toEqual([aliceA3.id, bobB1.id]);
  });

  it("dedupes across filters and caps at the max of the filters' limits", async () => {
    const rows = await queryEvents(env, [
      filter({ kinds: [30023], limit: 1 }),
      filter({ authors: [ALICE_PK], kinds: [30023], limit: 2 }),
    ]);
    // Filter 1 yields a3; filter 2 yields a3+a2. a3 deduped; global cap =
    // max(1, 2) = 2.
    expect(rows.map((r) => r.id)).toEqual([aliceA3.id, aliceA2.id]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("returns [] for an empty filter list", async () => {
    expect(await queryEvents(env, [])).toEqual([]);
  });

  it("serves only the newest version of a replaceable slot", async () => {
    const v1 = post(ALICE_SK, "evolving", 4000, [], "first draft");
    const v2 = post(ALICE_SK, "evolving", 4500, [], "second draft");
    expect(await mirrorEvent(env, v1)).toBe("stored");
    expect(await mirrorEvent(env, v2)).toBe("stored");

    const rows = await queryEvents(env, [filter({ dTags: ["evolving"] })]);
    expect(rows.map((r) => r.id)).toEqual([v2.id]);
    // the losing version is gone entirely, even when asked for by id
    expect(await queryEvents(env, [filter({ ids: [v1.id] })])).toEqual([]);
  });

  it("excludes tombstoned posts but still serves the kind-5 delete", async () => {
    const doomed = post(ALICE_SK, "doomed", 4000);
    expect(await mirrorEvent(env, doomed)).toBe("stored");
    // visible before the delete
    let rows = await queryEvents(env, [filter({ dTags: ["doomed"] })]);
    expect(rows.map((r) => r.id)).toEqual([doomed.id]);

    const del = sign(ALICE_SK, {
      kind: 5,
      created_at: 4100,
      tags: [
        ["e", doomed.id],
        ["a", `30023:${ALICE_PK}:doomed`],
      ],
      content: "Deleted via nbread.lol",
    });
    expect(await mirrorEvent(env, del)).toBe("stored");

    // the post is tombstoned everywhere: by #d, by id, by author scan
    expect(await queryEvents(env, [filter({ dTags: ["doomed"] })])).toEqual([]);
    expect(await queryEvents(env, [filter({ ids: [doomed.id] })])).toEqual([]);
    const authorRows = await queryEvents(env, [
      filter({ authors: [ALICE_PK], kinds: [30023] }),
    ]);
    expect(authorRows.map((r) => r.id)).not.toContain(doomed.id);

    // …but the kind-5 delete itself stays servable (deleted = 0 on kind 5)
    const deletes = await queryEvents(env, [
      filter({ authors: [ALICE_PK], kinds: [5] }),
    ]);
    expect(deletes.map((r) => r.id)).toEqual([del.id]);
    expect(await queryEvents(env, [filter({ ids: [del.id] })])).toHaveLength(1);
  });
});
