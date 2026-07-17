// PR2 packet 1: REQ filter sanitation cap matrix + in-memory event matching
// (live fan-out semantics). Pure — no fixtures, no I/O; matching needs no
// signatures, so events are plain structural objects.
import { describe, expect, it } from "vitest";
import type { NostrEvent } from "../../src/nostr/event";
import {
  DEFAULT_LIMIT,
  matchesAnyFilter,
  matchEvent,
  MAX_FILTER_AUTHORS,
  MAX_FILTER_IDS,
  MAX_FILTER_KINDS,
  MAX_LIMIT,
  MAX_REQ_FILTERS,
  MAX_TAG_FILTER_VALUES,
  sanitizeFilters,
} from "../../src/relay/filters";
import type { SanitizedFilter } from "../../src/relay/types";

const ID_1 = "1".repeat(64);
const PK_A = "a".repeat(64);
const PK_B = "b".repeat(64);

/** n distinct 64-hex strings. */
function hexes(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
}

/** Sanitize and assert success. */
function ok(raw: unknown): SanitizedFilter[] {
  const res = sanitizeFilters(raw);
  if (!Array.isArray(res)) {
    throw new Error(`expected filters, got error: ${res.error}`);
  }
  return res;
}

/** Sanitize and assert failure, returning the error string. */
function err(raw: unknown): string {
  const res = sanitizeFilters(raw);
  if (Array.isArray(res)) throw new Error("expected an error");
  expect(res.error.length).toBeGreaterThan(0);
  return res.error;
}

function ev(over: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: ID_1,
    pubkey: PK_A,
    kind: 30023,
    created_at: 1000,
    tags: [
      ["d", "post-1"],
      ["t", "nostr"],
    ],
    content: "",
    sig: "f".repeat(128),
    ...over,
  };
}

describe("sanitizeFilters — accepted shapes", () => {
  it("empty filter → limit default only", () => {
    expect(ok([{}])).toEqual([{ limit: DEFAULT_LIMIT }]);
  });

  it("full filter maps every supported key", () => {
    const [f] = ok([
      {
        ids: [ID_1],
        authors: [PK_A, PK_B],
        kinds: [30023, 5, 0],
        since: 100,
        until: 200,
        limit: 25,
        "#d": ["post-1"],
        "#t": ["nostr", "blog"],
        "#e": [ID_1],
      },
    ]);
    expect(f).toEqual({
      ids: [ID_1],
      authors: [PK_A, PK_B],
      kinds: [30023, 5, 0],
      since: 100,
      until: 200,
      limit: 25,
      dTags: ["post-1"],
      tagFilters: { t: ["nostr", "blog"], e: [ID_1] },
    });
  });

  it("accepts up to MAX_REQ_FILTERS filters", () => {
    expect(ok(Array.from({ length: MAX_REQ_FILTERS }, () => ({})))).toHaveLength(
      MAX_REQ_FILTERS,
    );
  });

  it("accepts exactly-at-cap list sizes", () => {
    const [f] = ok([
      {
        ids: hexes(MAX_FILTER_IDS),
        authors: hexes(MAX_FILTER_AUTHORS),
        kinds: Array.from({ length: MAX_FILTER_KINDS }, (_, i) => i),
        "#t": Array.from({ length: MAX_TAG_FILTER_VALUES }, (_, i) => `t${i}`),
      },
    ]);
    expect(f?.ids).toHaveLength(MAX_FILTER_IDS);
    expect(f?.tagFilters?.t).toHaveLength(MAX_TAG_FILTER_VALUES);
  });

  it("clamps limit into [1, MAX_LIMIT] and defaults to DEFAULT_LIMIT", () => {
    expect(ok([{ limit: 0 }])[0]?.limit).toBe(1);
    expect(ok([{ limit: -5 }])[0]?.limit).toBe(1);
    expect(ok([{ limit: 9999 }])[0]?.limit).toBe(MAX_LIMIT);
    expect(ok([{ limit: MAX_LIMIT }])[0]?.limit).toBe(MAX_LIMIT);
    expect(ok([{ limit: 7 }])[0]?.limit).toBe(7);
    expect(ok([{}])[0]?.limit).toBe(DEFAULT_LIMIT);
  });

  it("ignores unknown non-tag keys and non-single-letter #keys (NIP-01)", () => {
    const [f] = ok([
      { search: "hello", foo: 1, "#dd": ["x"], "#": ["y"], "#1": ["z"] },
    ]);
    expect(f).toEqual({ limit: DEFAULT_LIMIT });
  });
});

describe("sanitizeFilters — rejection matrix", () => {
  it("rejects non-array input and an empty filter list", () => {
    err({});
    err("nope");
    err(null);
    expect(err([])).toMatch(/at least one/);
  });

  it("rejects more than MAX_REQ_FILTERS filters", () => {
    expect(
      err(Array.from({ length: MAX_REQ_FILTERS + 1 }, () => ({}))),
    ).toMatch(/too many filters/);
  });

  it("rejects non-object filters", () => {
    err([null]);
    err([[]]);
    err(["x"]);
    err([42]);
    // one bad filter poisons the whole REQ
    err([{}, null]);
  });

  it("rejects oversized id/author/kind/tag lists", () => {
    err([{ ids: hexes(MAX_FILTER_IDS + 1) }]);
    err([{ authors: hexes(MAX_FILTER_AUTHORS + 1) }]);
    err([{ kinds: Array.from({ length: MAX_FILTER_KINDS + 1 }, (_, i) => i) }]);
    err([
      {
        "#d": Array.from({ length: MAX_TAG_FILTER_VALUES + 1 }, (_, i) => `${i}`),
      },
    ]);
    err([
      {
        "#t": Array.from({ length: MAX_TAG_FILTER_VALUES + 1 }, (_, i) => `${i}`),
      },
    ]);
  });

  it("rejects malformed hex in ids/authors", () => {
    err([{ ids: ["zz".repeat(32)] }]); // non-hex
    err([{ ids: ["a".repeat(63)] }]); // short
    err([{ ids: ["A".repeat(64)] }]); // uppercase is non-canonical
    err([{ authors: [PK_A.slice(0, 8)] }]); // NIP-01 prefixes unsupported
    err([{ authors: [42] }]);
    err([{ ids: "not-a-list" }]);
  });

  it("rejects empty lists (ambiguous between engines — fail closed)", () => {
    err([{ ids: [] }]);
    err([{ authors: [] }]);
    err([{ kinds: [] }]);
    err([{ "#d": [] }]);
    err([{ "#t": [] }]);
  });

  it("rejects malformed kinds", () => {
    err([{ kinds: [-1] }]);
    err([{ kinds: [65536] }]);
    err([{ kinds: [1.5] }]);
    err([{ kinds: ["1"] }]);
    err([{ kinds: 30023 }]);
  });

  it("rejects malformed since/until", () => {
    err([{ since: "100" }]);
    err([{ since: -1 }]);
    err([{ since: 1.5 }]);
    err([{ until: null }]);
    err([{ until: Number.NaN }]);
  });

  it("rejects malformed limit (clamp only applies to integers)", () => {
    err([{ limit: "5" }]);
    err([{ limit: 1.5 }]);
    err([{ limit: null }]);
  });

  it("rejects non-string and oversized tag filter values", () => {
    err([{ "#t": [42] }]);
    err([{ "#d": [null] }]);
    err([{ "#t": ["x".repeat(8193)] }]); // > MAX_TAG_ITEM_LENGTH can never match
    err([{ "#t": "nostr" }]);
  });
});

describe("matchEvent", () => {
  const only = (f: Partial<SanitizedFilter>): SanitizedFilter => ({
    limit: DEFAULT_LIMIT,
    ...f,
  });

  it("empty filter matches everything", () => {
    expect(matchEvent(only({}), ev())).toBe(true);
    expect(matchEvent(only({}), ev({ kind: 5, tags: [] }))).toBe(true);
  });

  it("ids", () => {
    expect(matchEvent(only({ ids: [ID_1] }), ev())).toBe(true);
    expect(matchEvent(only({ ids: ["2".repeat(64)] }), ev())).toBe(false);
  });

  it("authors", () => {
    expect(matchEvent(only({ authors: [PK_A, PK_B] }), ev())).toBe(true);
    expect(matchEvent(only({ authors: [PK_B] }), ev())).toBe(false);
  });

  it("kinds", () => {
    expect(matchEvent(only({ kinds: [30023, 5] }), ev())).toBe(true);
    expect(matchEvent(only({ kinds: [0] }), ev())).toBe(false);
  });

  it("since/until are inclusive bounds on created_at", () => {
    expect(matchEvent(only({ since: 1000 }), ev())).toBe(true);
    expect(matchEvent(only({ since: 1001 }), ev())).toBe(false);
    expect(matchEvent(only({ until: 1000 }), ev())).toBe(true);
    expect(matchEvent(only({ until: 999 }), ev())).toBe(false);
    expect(matchEvent(only({ since: 900, until: 1100 }), ev())).toBe(true);
  });

  it("#d matches the SLOTTED d value (mirrors the SQL d_tag column)", () => {
    expect(matchEvent(only({ dTags: ["post-1"] }), ev())).toBe(true);
    expect(matchEvent(only({ dTags: ["other"] }), ev())).toBe(false);
    // A 30023 with two d tags slots under its FIRST d tag only — matching a
    // later d value must miss, exactly as `d_tag IN (...)` would.
    const twoD = ev({
      tags: [
        ["d", "x"],
        ["d", "y"],
      ],
    });
    expect(matchEvent(only({ dTags: ["x"] }), twoD)).toBe(true);
    expect(matchEvent(only({ dTags: ["y"] }), twoD)).toBe(false);
    // Non-parameterized kinds slot under "" even with a stray d tag, so a #d
    // filter for that stray value must miss while "" hits.
    const strayD = ev({ kind: 5, tags: [["d", "foo"]] });
    expect(matchEvent(only({ dTags: ["foo"] }), strayD)).toBe(false);
    expect(matchEvent(only({ dTags: [""] }), strayD)).toBe(true);
  });

  it("generic tag filters match any-tag, AND across letters", () => {
    expect(matchEvent(only({ tagFilters: { t: ["nostr"] } }), ev())).toBe(true);
    expect(matchEvent(only({ tagFilters: { t: ["bitcoin"] } }), ev())).toBe(
      false,
    );
    // both letters must hit
    expect(
      matchEvent(only({ tagFilters: { t: ["nostr"], e: [ID_1] } }), ev()),
    ).toBe(false);
    const withE = ev({
      tags: [
        ["t", "nostr"],
        ["e", ID_1],
      ],
    });
    expect(
      matchEvent(only({ tagFilters: { t: ["nostr"], e: [ID_1] } }), withE),
    ).toBe(true);
  });

  it("valueless tags never match and never throw", () => {
    const bare = ev({ tags: [["t"]] });
    expect(matchEvent(only({ tagFilters: { t: ["nostr"] } }), bare)).toBe(
      false,
    );
  });

  it("all present conditions AND together within one filter", () => {
    const f = only({ kinds: [30023], authors: [PK_B] });
    expect(matchEvent(f, ev())).toBe(false); // kind hits, author misses
    expect(matchEvent(f, ev({ pubkey: PK_B }))).toBe(true);
  });

  it("sanitizeFilters output feeds matchEvent directly (round trip)", () => {
    const filters = ok([{ kinds: [30023], "#t": ["nostr"], "#d": ["post-1"] }]);
    const f = filters[0];
    expect(f).toBeDefined();
    if (f === undefined) return;
    expect(matchEvent(f, ev())).toBe(true);
    expect(matchEvent(f, ev({ kind: 1 }))).toBe(false);
  });
});

describe("matchesAnyFilter (REQ = OR of filters)", () => {
  const miss: SanitizedFilter = { limit: 100, kinds: [0] };
  const hit: SanitizedFilter = { limit: 100, kinds: [30023] };

  it("true when any filter matches", () => {
    expect(matchesAnyFilter([miss, hit], ev())).toBe(true);
    expect(matchesAnyFilter([hit, miss], ev())).toBe(true);
  });

  it("false when no filter matches, or the list is empty", () => {
    expect(matchesAnyFilter([miss, miss], ev())).toBe(false);
    expect(matchesAnyFilter([], ev())).toBe(false);
  });
});
