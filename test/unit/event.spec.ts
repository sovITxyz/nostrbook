// P1: NIP-01 event primitives — canonical id, schnorr verify, structural
// rejection, replaceable resolution. Uses committed fixtures only.
import { describe, expect, it } from "vitest";
import {
  getDTag,
  getEventId,
  isNostrEvent,
  MAX_CONTENT_LENGTH,
  MAX_TAG_ITEM_LENGTH,
  MAX_TAGS,
  resolveReplaceable,
  serializeEvent,
  verifyEvent,
  type NostrEvent,
} from "../../src/nostr/event";
import fixtures from "../fixtures/events.json";

const profiles = Object.values(fixtures.profiles) as NostrEvent[];
const posts = Object.values(fixtures.posts) as NostrEvent[];
const stale = fixtures.replaceable.stale as NostrEvent;
const newer = fixtures.replaceable.newer as NostrEvent;
const deleteEvent = fixtures.delete as NostrEvent;
const tampered = fixtures.tampered as { reason: string; event: NostrEvent }[];
const allValid = [...profiles, ...posts, stale, newer, deleteEvent];

const aliceHello = fixtures.posts.aliceHello as NostrEvent;

/** Call verifyEvent with a deliberately malformed value. */
const verifyRaw = (value: unknown) => verifyEvent(value as NostrEvent);

describe("serializeEvent / getEventId", () => {
  it("produces the exact NIP-01 canonical form", () => {
    const s = serializeEvent({
      pubkey: "ab",
      created_at: 1,
      kind: 1,
      tags: [["d", "x"]],
      content: 'a"b\nc',
    });
    expect(s).toBe('[0,"ab",1,1,[["d","x"]],"a\\"b\\nc"]');
  });

  it("recomputes the committed id for every valid fixture", () => {
    for (const ev of allValid) {
      expect(getEventId(ev), `id of ${ev.id}`).toBe(ev.id);
    }
  });
});

describe("verifyEvent — valid fixtures", () => {
  it("accepts every valid fixture (profiles, posts, replaceable pair, delete)", async () => {
    expect(allValid.length).toBeGreaterThanOrEqual(10);
    for (const ev of allValid) {
      expect(await verifyEvent(ev), `event ${ev.id}`).toBe(true);
    }
  });

  it("tolerates extra non-standard fields (relays attach metadata)", async () => {
    const withExtra = { ...aliceHello, seenOn: ["wss://relay.example"] };
    expect(await verifyRaw(withExtra)).toBe(true);
  });
});

describe("verifyEvent — tampered fixtures", () => {
  it("covers every tamper class", () => {
    expect(tampered.map((t) => t.reason).sort()).toEqual([
      "bad_id",
      "bad_sig",
      "wrong_pubkey",
    ]);
  });

  for (const { reason, event } of tampered) {
    it(`rejects tampered event (${reason})`, async () => {
      expect(await verifyEvent(event)).toBe(false);
    });
  }
});

describe("verifyEvent — structural rejection before crypto", () => {
  const structurallyInvalid: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["array", [aliceHello]],
    ["string", JSON.stringify(aliceHello)],
    ["missing id", { ...aliceHello, id: undefined }],
    ["missing pubkey", { ...aliceHello, pubkey: undefined }],
    ["missing sig", { ...aliceHello, sig: undefined }],
    ["missing kind", { ...aliceHello, kind: undefined }],
    ["missing created_at", { ...aliceHello, created_at: undefined }],
    ["missing tags", { ...aliceHello, tags: undefined }],
    ["missing content", { ...aliceHello, content: undefined }],
    ["uppercase id", { ...aliceHello, id: aliceHello.id.toUpperCase() }],
    ["short id (63 chars)", { ...aliceHello, id: aliceHello.id.slice(0, 63) }],
    ["long id (65 chars)", { ...aliceHello, id: aliceHello.id + "a" }],
    ["non-hex id", { ...aliceHello, id: "z".repeat(64) }],
    [
      "uppercase pubkey",
      { ...aliceHello, pubkey: aliceHello.pubkey.toUpperCase() },
    ],
    ["non-hex sig", { ...aliceHello, sig: "zz" + aliceHello.sig.slice(2) }],
    ["short sig (127 chars)", { ...aliceHello, sig: aliceHello.sig.slice(0, 127) }],
    ["numeric sig", { ...aliceHello, sig: 123 }],
    ["float kind", { ...aliceHello, kind: 1.5 }],
    ["negative kind", { ...aliceHello, kind: -1 }],
    ["kind above 65535", { ...aliceHello, kind: 70000 }],
    ["string kind", { ...aliceHello, kind: "30023" }],
    ["float created_at", { ...aliceHello, created_at: 1700000100.5 }],
    ["negative created_at", { ...aliceHello, created_at: -5 }],
    ["string created_at", { ...aliceHello, created_at: "1700000100" }],
    ["tags not an array", { ...aliceHello, tags: "d" }],
    ["tag not an array", { ...aliceHello, tags: ["d"] }],
    ["non-string tag item", { ...aliceHello, tags: [["d", 42]] }],
    ["numeric content", { ...aliceHello, content: 42 }],
    [
      "oversized content (> MAX_CONTENT_LENGTH)",
      { ...aliceHello, content: "x".repeat(MAX_CONTENT_LENGTH + 1) },
    ],
    [
      "too many tags (> MAX_TAGS)",
      {
        ...aliceHello,
        tags: Array.from({ length: MAX_TAGS + 1 }, () => ["t", "x"]),
      },
    ],
    [
      "oversized tag item (> MAX_TAG_ITEM_LENGTH)",
      { ...aliceHello, tags: [["d", "x".repeat(MAX_TAG_ITEM_LENGTH + 1)]] },
    ],
  ];

  for (const [label, value] of structurallyInvalid) {
    it(`rejects ${label}`, async () => {
      expect(isNostrEvent(value)).toBe(false);
      expect(await verifyRaw(value)).toBe(false);
    });
  }

  it("isNostrEvent accepts every valid fixture", () => {
    for (const ev of allValid) {
      expect(isNostrEvent(ev), `event ${ev.id}`).toBe(true);
    }
  });

  it("accepts sizes exactly at the caps (structural check only)", () => {
    expect(
      isNostrEvent({ ...aliceHello, content: "x".repeat(MAX_CONTENT_LENGTH) }),
    ).toBe(true);
    expect(
      isNostrEvent({
        ...aliceHello,
        tags: Array.from({ length: MAX_TAGS }, () => ["t", "x"]),
      }),
    ).toBe(true);
    expect(
      isNostrEvent({
        ...aliceHello,
        tags: [["d", "x".repeat(MAX_TAG_ITEM_LENGTH)]],
      }),
    ).toBe(true);
  });
});

describe("getDTag", () => {
  it("returns the first d tag value", () => {
    expect(getDTag(aliceHello)).toBe("hello-world");
  });

  it("returns '' when there is no d tag (kind 0 profile)", () => {
    expect(getDTag(profiles[0]!)).toBe("");
  });

  it("returns '' for a bare ['d'] tag with no value", () => {
    expect(getDTag({ ...aliceHello, tags: [["d"]] })).toBe("");
  });
});

describe("resolveReplaceable", () => {
  /** Synthetic (unverified) event for pure-data resolution tests. */
  const synth = (over: Partial<NostrEvent>): NostrEvent => ({
    ...aliceHello,
    ...over,
  });

  it("newest created_at wins for the fixture replaceable pair (both input orders)", () => {
    expect(resolveReplaceable([stale, newer])).toEqual([newer]);
    expect(resolveReplaceable([newer, stale])).toEqual([newer]);
  });

  it("breaks created_at ties by lexicographically lower id (both input orders)", () => {
    const low = synth({ id: "a".repeat(64), created_at: 1700000500 });
    const high = synth({ id: "f".repeat(64), created_at: 1700000500 });
    expect(resolveReplaceable([low, high])).toEqual([low]);
    expect(resolveReplaceable([high, low])).toEqual([low]);
  });

  it("keeps events with distinct d tags separately", () => {
    const winners = resolveReplaceable([...posts]);
    expect(winners).toHaveLength(posts.length);
  });

  it("keeps events with distinct pubkeys separately", () => {
    const a = synth({ id: "1".repeat(64), pubkey: "a".repeat(64) });
    const b = synth({ id: "2".repeat(64), pubkey: "b".repeat(64) });
    expect(resolveReplaceable([a, b])).toHaveLength(2);
  });

  it("keeps events with distinct kinds separately", () => {
    const a = synth({ id: "1".repeat(64), kind: 30023 });
    const b = synth({ id: "2".repeat(64), kind: 30024 });
    expect(resolveReplaceable([a, b])).toHaveLength(2);
  });

  it("resolves kind-0 profiles (no d tag) newest-wins per pubkey", () => {
    const older = synth({ id: "1".repeat(64), kind: 0, tags: [], created_at: 100 });
    const newest = synth({ id: "2".repeat(64), kind: 0, tags: [], created_at: 200 });
    expect(resolveReplaceable([older, newest])).toEqual([newest]);
  });

  it("treats a missing d tag and ['d', ''] as the same bucket", () => {
    const noTag = synth({ id: "1".repeat(64), tags: [], created_at: 100 });
    const emptyTag = synth({ id: "2".repeat(64), tags: [["d", ""]], created_at: 200 });
    expect(resolveReplaceable([noTag, emptyTag])).toEqual([emptyTag]);
  });

  it("returns [] for empty input", () => {
    expect(resolveReplaceable([])).toEqual([]);
  });
});
