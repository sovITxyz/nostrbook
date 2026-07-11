// P1: NIP-19 codecs — npub/naddr round-trips, interop vectors, and rejection
// of wrong prefixes, corrupt bech32, and malformed TLV.
// Expected strings were cross-generated with nostr-tools from the committed
// fixture keys (dev-time, not at test time).
import { describe, expect, it } from "vitest";
import {
  bech32EncodeBytes,
  naddrDecode,
  naddrEncode,
  npubDecode,
  npubEncode,
} from "../../src/nostr/nip19";
import keys from "../fixtures/keys.json";

const KNOWN_NPUBS: [string, string][] = [
  [keys.alice.pk, "npub1rwzv24nmzfjypx2a8m264ws9vht3uxp5vpypnluuzl67n4waq78suk0wul"],
  [keys.bob.pk, "npub1f49ke5fkzqev4x7j46uajq92f4zan6kcpty5yvm5c3g6wf2dqanqn7qsy2"],
  [keys.mallory.pk, "npub12v07vp5px3gr6ferzvez0jr84j86djpu2dlf53xrck7mmjcluvms5dn8ru"],
  // NIP-19 spec example vector
  [
    "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d",
    "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6",
  ],
];

// nsecEncode(alice.sk) via nostr-tools — used only as a wrong-prefix input.
const ALICE_NSEC =
  "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw";

describe("npubEncode / npubDecode", () => {
  for (const [hex, npub] of KNOWN_NPUBS) {
    it(`encodes ${hex.slice(0, 8)}… to the known npub`, () => {
      expect(npubEncode(hex)).toBe(npub);
    });
    it(`decodes ${npub.slice(0, 14)}… back to hex`, () => {
      expect(npubDecode(npub)).toBe(hex);
    });
  }

  it("round-trips all fixture pubkeys", () => {
    for (const pk of [keys.alice.pk, keys.bob.pk, keys.mallory.pk]) {
      expect(npubDecode(npubEncode(pk))).toBe(pk);
    }
  });

  it("accepts all-uppercase bech32 (BIP-173)", () => {
    const npub = npubEncode(keys.alice.pk);
    expect(npubDecode(npub.toUpperCase())).toBe(keys.alice.pk);
  });

  it("rejects invalid hex input to npubEncode", () => {
    expect(() => npubEncode(keys.alice.pk.toUpperCase())).toThrow();
    expect(() => npubEncode(keys.alice.pk.slice(0, 63))).toThrow();
    expect(() => npubEncode("z".repeat(64))).toThrow();
    expect(() => npubEncode("")).toThrow();
  });

  it("rejects wrong-prefix entities (nsec, naddr)", () => {
    expect(() => npubDecode(ALICE_NSEC)).toThrow(/expected npub/);
    const naddr = naddrEncode({
      identifier: "hello-world",
      pubkey: keys.alice.pk,
      kind: 30023,
    });
    expect(() => npubDecode(naddr)).toThrow(/expected npub/);
  });

  it("rejects corrupt bech32", () => {
    const npub = npubEncode(keys.alice.pk);
    // flipped final (checksum) character
    const flipped = npub.slice(0, -1) + (npub.endsWith("q") ? "p" : "q");
    expect(() => npubDecode(flipped)).toThrow(/checksum/);
    // character outside the bech32 charset
    expect(() => npubDecode(npub.slice(0, 20) + "b" + npub.slice(21))).toThrow();
    // mixed case
    expect(() => npubDecode(npub.slice(0, 10) + npub.slice(10).toUpperCase())).toThrow(
      /mixed-case/,
    );
    // truncation
    expect(() => npubDecode(npub.slice(0, 20))).toThrow();
    expect(() => npubDecode("npub1")).toThrow();
    expect(() => npubDecode("")).toThrow();
    // no separator / hrp-less garbage
    expect(() => npubDecode(keys.alice.pk)).toThrow();
  });

  it("rejects an npub whose payload is not 32 bytes", () => {
    const bad = bech32EncodeBytes("npub", new Uint8Array(33));
    expect(() => npubDecode(bad)).toThrow(/32 bytes/);
  });
});

describe("naddrEncode / naddrDecode", () => {
  const alicePointer = {
    identifier: "hello-world",
    pubkey: keys.alice.pk,
    kind: 30023,
  };

  it("matches nostr-tools byte-for-byte (with relay hint)", () => {
    expect(
      naddrEncode({ ...alicePointer, relays: ["wss://relay.damus.io"] }),
    ).toBe(
      "naddr1qvzqqqr4gupzqxuyc4t8kynygzv460k442aq2ewhrcvrgczgr8lec9l4a82a6pu0qy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsqzmgv4kxcmedwahhymryd6ry9n",
    );
  });

  it("matches nostr-tools byte-for-byte (no relays)", () => {
    expect(naddrEncode(alicePointer)).toBe(
      "naddr1qvzqqqr4gupzqxuyc4t8kynygzv460k442aq2ewhrcvrgczgr8lec9l4a82a6pu0qq9ksetvd3hj6am0wfkxgvzmzam",
    );
  });

  it("round-trips with relays", () => {
    const ptr = {
      ...alicePointer,
      relays: ["wss://relay.damus.io", "wss://nos.lol"],
    };
    expect(naddrDecode(naddrEncode(ptr))).toEqual(ptr);
  });

  it("round-trips without relays (relays key omitted)", () => {
    const decoded = naddrDecode(naddrEncode(alicePointer));
    expect(decoded).toEqual(alicePointer);
    expect(decoded.relays).toBeUndefined();
  });

  it("round-trips an empty identifier", () => {
    const ptr = { identifier: "", pubkey: keys.bob.pk, kind: 30023 };
    expect(naddrDecode(naddrEncode(ptr))).toEqual(ptr);
  });

  it("round-trips a unicode identifier", () => {
    const ptr = { identifier: "héllo-🦩", pubkey: keys.bob.pk, kind: 30023 };
    expect(naddrDecode(naddrEncode(ptr))).toEqual(ptr);
  });

  it("round-trips kind 0", () => {
    const ptr = { identifier: "meta", pubkey: keys.mallory.pk, kind: 0 };
    expect(naddrDecode(naddrEncode(ptr))).toEqual(ptr);
  });

  it("rejects invalid pointers in naddrEncode", () => {
    expect(() => naddrEncode({ ...alicePointer, pubkey: "nothex" })).toThrow();
    expect(() => naddrEncode({ ...alicePointer, kind: 1.5 })).toThrow();
    expect(() => naddrEncode({ ...alicePointer, kind: -1 })).toThrow();
    expect(() => naddrEncode({ ...alicePointer, kind: 2 ** 32 })).toThrow();
    expect(() =>
      naddrEncode({ ...alicePointer, identifier: "x".repeat(300) }),
    ).toThrow(/too long/);
    expect(() =>
      naddrEncode({ ...alicePointer, relays: ["wss://" + "r".repeat(300)] }),
    ).toThrow(/too long/);
  });

  it("rejects wrong-prefix entities", () => {
    expect(() => naddrDecode(npubEncode(keys.alice.pk))).toThrow(/expected naddr/);
    expect(() => naddrDecode(ALICE_NSEC)).toThrow(/expected naddr/);
  });

  it("rejects corrupt bech32", () => {
    const naddr = naddrEncode(alicePointer);
    const flipped = naddr.slice(0, -1) + (naddr.endsWith("q") ? "p" : "q");
    expect(() => naddrDecode(flipped)).toThrow(/checksum/);
    expect(() => naddrDecode(naddr.slice(0, 30))).toThrow();
  });

  // Hand-crafted TLV payloads (encoded with the low-level bech32 helper).
  const AUTHOR_TLV = [2, 32, ...new Uint8Array(32).fill(7)];
  const KIND_TLV = [3, 4, 0, 0, 0x75, 0x47]; // 30023
  const SPECIAL_TLV = [0, 3, 0x61, 0x62, 0x63]; // "abc"
  const craft = (bytes: number[]) =>
    bech32EncodeBytes("naddr", Uint8Array.from(bytes));

  it("rejects TLV missing the author entry", () => {
    expect(() => naddrDecode(craft([...SPECIAL_TLV, ...KIND_TLV]))).toThrow(
      /missing author/,
    );
  });

  it("rejects TLV missing the kind entry", () => {
    expect(() => naddrDecode(craft([...SPECIAL_TLV, ...AUTHOR_TLV]))).toThrow(
      /missing kind/,
    );
  });

  it("rejects TLV missing the identifier entry", () => {
    expect(() => naddrDecode(craft([...AUTHOR_TLV, ...KIND_TLV]))).toThrow(
      /missing identifier/,
    );
  });

  it("rejects an author TLV that is not 32 bytes", () => {
    const shortAuthor = [2, 31, ...new Uint8Array(31)];
    expect(() =>
      naddrDecode(craft([...SPECIAL_TLV, ...shortAuthor, ...KIND_TLV])),
    ).toThrow(/32 bytes/);
  });

  it("rejects a kind TLV that is not 4 bytes", () => {
    const shortKind = [3, 3, 0, 0, 1];
    expect(() =>
      naddrDecode(craft([...SPECIAL_TLV, ...AUTHOR_TLV, ...shortKind])),
    ).toThrow(/4 bytes/);
  });

  it("rejects truncated TLV values and headers", () => {
    expect(() => naddrDecode(craft([0, 10, 1, 2]))).toThrow(/truncated/);
    expect(() =>
      naddrDecode(craft([...SPECIAL_TLV, ...AUTHOR_TLV, ...KIND_TLV, 5])),
    ).toThrow(/truncated/);
  });

  it("rejects duplicate author TLVs", () => {
    expect(() =>
      naddrDecode(craft([...SPECIAL_TLV, ...AUTHOR_TLV, ...AUTHOR_TLV, ...KIND_TLV])),
    ).toThrow(/duplicate/);
  });

  it("rejects invalid UTF-8 in the identifier", () => {
    expect(() =>
      naddrDecode(craft([0, 1, 0xff, ...AUTHOR_TLV, ...KIND_TLV])),
    ).toThrow();
  });

  it("ignores unknown TLV types (forward compatibility)", () => {
    const decoded = naddrDecode(
      craft([...SPECIAL_TLV, ...AUTHOR_TLV, ...KIND_TLV, 99, 1, 7]),
    );
    expect(decoded).toEqual({
      identifier: "abc",
      pubkey: "07".repeat(32),
      kind: 30023,
    });
  });
});
