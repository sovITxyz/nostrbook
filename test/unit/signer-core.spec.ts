// Packet B: the pure signer core (public/js/signer-core.js) behind the
// NbreadSigner dispatcher. The IIFE is imported for its side effect (it
// assigns globalThis.NbreadSignerCore) and exercised directly against the
// committed crypto vendor bundle. signer.js itself is deliberately NOT
// imported here — it touches window/localStorage/location and cannot load in
// workerd.
import { describe, expect, it } from "vitest";
// @ts-ignore — plain browser IIFE, intentionally shipped without types
import "../../public/js/vendor/nostr-crypto.js";
// @ts-ignore — plain browser IIFE, intentionally shipped without types
import "../../public/js/signer-core.js";
import keys from "../fixtures/keys.json";

type Unsigned = {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  id?: string;
};

type PendingRecord = {
  kind: string;
  unsigned: (Unsigned & { id: string }) | null;
  returnTo: string;
  ts: number;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const C = (globalThis as any).NbreadCrypto as {
  hexToBytes: (hex: string) => Uint8Array;
  npubEncode: (pkHex: string) => string;
  nsecEncode: (skHex: string) => string;
  eventId: (unsigned: Unsigned) => string;
  getPublicKeyHex: (skBytes: Uint8Array) => string;
};

const Core = (globalThis as any).NbreadSignerCore as {
  decodeNsec: (input: string) => { skHex: string; pkHex: string; npub: string };
  normalizePubkey: (input: string) => string;
  buildNip55Intent: (opts: {
    type: string;
    callbackUrl: string;
    eventJson?: string;
  }) => string;
  parseNip55Callback: (search: string) => {
    kind: "pubkey" | "sign" | null;
    value: string | null;
  };
  makePendingRecord: (opts: {
    kind: string;
    unsigned: (Unsigned & { id: string }) | null;
    returnTo: string;
    nowSec: number;
  }) => PendingRecord;
  validatePending: (record: unknown, nowSec: number, ttlSec?: number) => boolean;
  completeUnsigned: (
    unsigned: Partial<Unsigned>,
    pubkeyHex: string,
    nowSec: number,
  ) => Unsigned & { id: string };
};

const SIG_128 = "ab".repeat(64); // shape-valid 128-hex signature stand-in

describe("NbreadSignerCore.decodeNsec", () => {
  const aliceNsec = C.nsecEncode(keys.alice.sk);

  it("decodes a valid nsec1 string and derives pubkey + npub", () => {
    const decoded = Core.decodeNsec(aliceNsec);
    expect(decoded.skHex).toBe(keys.alice.sk);
    expect(decoded.pkHex).toBe(keys.alice.pk);
    expect(decoded.npub).toBe(C.npubEncode(keys.alice.pk));
  });

  it("accepts raw 64-hex (either case, surrounding whitespace)", () => {
    expect(Core.decodeNsec(keys.bob.sk).pkHex).toBe(keys.bob.pk);
    expect(Core.decodeNsec(`  ${keys.bob.sk.toUpperCase()}  `).skHex).toBe(keys.bob.sk);
  });

  it("derived pkHex matches NbreadCrypto.getPublicKeyHex", () => {
    const decoded = Core.decodeNsec(keys.mallory.sk);
    expect(decoded.pkHex).toBe(C.getPublicKeyHex(C.hexToBytes(keys.mallory.sk)));
  });

  it("rejects the wrong hrp (an npub is not a secret key)", () => {
    expect(() => Core.decodeNsec(C.npubEncode(keys.alice.pk))).toThrow();
  });

  it("rejects a corrupted checksum", () => {
    const last = aliceNsec.slice(-1);
    const flipped = aliceNsec.slice(0, -1) + (last === "q" ? "p" : "q");
    expect(() => Core.decodeNsec(flipped)).toThrow();
  });

  it("rejects wrong lengths and junk", () => {
    expect(() => Core.decodeNsec(keys.alice.sk.slice(0, 62))).toThrow(); // 62 hex chars
    expect(() => Core.decodeNsec(keys.alice.sk + "00")).toThrow(); // 66 hex chars
    expect(() => Core.decodeNsec("not-a-key")).toThrow();
    expect(() => Core.decodeNsec("")).toThrow();
  });

  it("rejects out-of-range scalars the curve refuses", () => {
    expect(() => Core.decodeNsec("00".repeat(32))).toThrow(); // zero scalar
    expect(() => Core.decodeNsec("ff".repeat(32))).toThrow(); // >= group order
  });
});

describe("NbreadSignerCore.normalizePubkey", () => {
  it("accepts npub1… and 64-hex, normalizing to lowercase hex", () => {
    expect(Core.normalizePubkey(C.npubEncode(keys.alice.pk))).toBe(keys.alice.pk);
    expect(Core.normalizePubkey(keys.alice.pk)).toBe(keys.alice.pk);
    expect(Core.normalizePubkey(keys.alice.pk.toUpperCase())).toBe(keys.alice.pk);
  });

  it("rejects nsec strings, short hex, and junk", () => {
    expect(() => Core.normalizePubkey(C.nsecEncode(keys.alice.sk))).toThrow();
    expect(() => Core.normalizePubkey("abc123")).toThrow();
    expect(() => Core.normalizePubkey("")).toThrow();
  });
});

describe("NbreadSignerCore.buildNip55Intent", () => {
  const callbackUrl = "https://nbread.lol/write?nip55=sign&event=";

  it("builds the exact get_public_key intent URL", () => {
    const url = Core.buildNip55Intent({
      type: "get_public_key",
      callbackUrl: "https://nbread.lol/login?nip55=pubkey&event=",
    });
    expect(url).toBe(
      "intent:" +
        "#Intent;scheme=nostrsigner;S.compressionType=none;S.returnType=signature;" +
        "S.type=get_public_key;S.appName=nbread;" +
        "S.callbackUrl=https://nbread.lol/login?nip55=pubkey&event=;end",
    );
  });

  it("builds the exact sign_event intent URL with the event JSON URL-encoded", () => {
    // Special characters that must survive encodeURIComponent round-trips:
    // quotes, ampersands, hashes, semicolons, unicode.
    const eventJson = JSON.stringify({
      id: "cd".repeat(32),
      pubkey: keys.alice.pk,
      kind: 1,
      created_at: 1700000000,
      tags: [["t", "a&b"], ["client", "nbread"]],
      content: 'hello "world" — #tags & ; semicolons',
    });
    const url = Core.buildNip55Intent({
      type: "sign_event",
      callbackUrl,
      eventJson,
    });
    expect(url).toBe(
      "intent:" +
        encodeURIComponent(eventJson) +
        "#Intent;scheme=nostrsigner;S.compressionType=none;S.returnType=signature;" +
        "S.type=sign_event;S.appName=nbread;" +
        "S.callbackUrl=https://nbread.lol/write?nip55=sign&event=;end",
    );
    // The encoded payload must not leak raw intent-URL metacharacters.
    const payload = url.slice("intent:".length, url.indexOf("#Intent;"));
    expect(payload).not.toMatch(/[;#&" ]/);
    expect(decodeURIComponent(payload)).toBe(eventJson);
  });

  it("rejects unknown intent types and missing callback", () => {
    expect(() => Core.buildNip55Intent({ type: "nip04_decrypt", callbackUrl })).toThrow();
    expect(() => Core.buildNip55Intent({ type: "", callbackUrl })).toThrow();
    expect(() =>
      Core.buildNip55Intent({ type: "sign_event", callbackUrl: "" }),
    ).toThrow();
  });
});

describe("NbreadSignerCore.parseNip55Callback", () => {
  it("extracts the signature from the marked sign form", () => {
    expect(Core.parseNip55Callback(`?nip55=sign&event=${SIG_128}`)).toEqual({
      kind: "sign",
      value: SIG_128,
    });
  });

  it("extracts the pubkey from the marked pubkey form (hex and npub)", () => {
    const npub = C.npubEncode(keys.alice.pk);
    expect(Core.parseNip55Callback(`?nip55=pubkey&event=${keys.alice.pk}`)).toEqual({
      kind: "pubkey",
      value: keys.alice.pk,
    });
    expect(Core.parseNip55Callback(`?nip55=pubkey&event=${npub}`)).toEqual({
      kind: "pubkey",
      value: npub,
    });
  });

  it("tolerates generic-param variants across Amber versions", () => {
    // Signature under alternate names, no nip55 marker: inferred from shape.
    expect(Core.parseNip55Callback(`?sig=${SIG_128}`)).toEqual({
      kind: "sign",
      value: SIG_128,
    });
    expect(Core.parseNip55Callback(`?signature=${SIG_128}`)).toEqual({
      kind: "sign",
      value: SIG_128,
    });
    expect(Core.parseNip55Callback(`?event=${SIG_128}`)).toEqual({
      kind: "sign",
      value: SIG_128,
    });
    // Pubkey under alternate names.
    expect(Core.parseNip55Callback(`?result=${keys.bob.pk}`)).toEqual({
      kind: "pubkey",
      value: keys.bob.pk,
    });
    const npub = C.npubEncode(keys.bob.pk);
    expect(Core.parseNip55Callback(`?pubkey=${npub}`)).toEqual({
      kind: "pubkey",
      value: npub,
    });
  });

  it("keeps the marker's kind even when a value is missing (cancel case)", () => {
    expect(Core.parseNip55Callback("?nip55=sign")).toEqual({
      kind: "sign",
      value: null,
    });
    expect(Core.parseNip55Callback("?nip55=sign&event=")).toEqual({
      kind: "sign",
      value: null,
    });
  });

  it("returns null kind when nothing NIP-55-shaped is present", () => {
    expect(Core.parseNip55Callback("")).toEqual({ kind: null, value: null });
    expect(Core.parseNip55Callback("?")).toEqual({ kind: null, value: null });
    expect(Core.parseNip55Callback("?utm_source=x&page=2")).toEqual({
      kind: null,
      value: null,
    });
    // A value that is neither a signature nor a pubkey shape, with no marker.
    expect(Core.parseNip55Callback("?event=hello")).toEqual({
      kind: null,
      value: null,
    });
  });
});

describe("NbreadSignerCore pending records", () => {
  const NOW = 1_700_000_000;

  function unsignedWithId(): Unsigned & { id: string } {
    const unsigned: Unsigned = {
      pubkey: keys.alice.pk,
      created_at: NOW,
      kind: 30023,
      tags: [["d", "my-post"]],
      content: "hello",
    };
    return { ...unsigned, id: C.eventId(unsigned) };
  }

  it("makePendingRecord builds a stashable record", () => {
    const unsigned = unsignedWithId();
    const record = Core.makePendingRecord({
      kind: "publish",
      unsigned,
      returnTo: "/write?slug=my-post",
      nowSec: NOW,
    });
    expect(record).toEqual({
      kind: "publish",
      unsigned,
      returnTo: "/write?slug=my-post",
      ts: NOW,
    });
    // Survives the JSON round-trip through localStorage.
    expect(Core.validatePending(JSON.parse(JSON.stringify(record)), NOW)).toBe(true);
  });

  it("makePendingRecord rejects unknown kinds and half-built events", () => {
    const unsigned = unsignedWithId();
    expect(() =>
      Core.makePendingRecord({ kind: "evil", unsigned, returnTo: "/", nowSec: NOW }),
    ).toThrow();
    const noId = { ...unsigned } as Partial<Unsigned>;
    delete noId.id;
    expect(() =>
      Core.makePendingRecord({
        kind: "publish",
        unsigned: noId as Unsigned & { id: string },
        returnTo: "/",
        nowSec: NOW,
      }),
    ).toThrow();
  });

  it("allows a null unsigned for get_public_key round-trips", () => {
    const record = Core.makePendingRecord({
      kind: "login",
      unsigned: null,
      returnTo: "/login",
      nowSec: NOW,
    });
    expect(record.unsigned).toBeNull();
    expect(Core.validatePending(record, NOW + 5)).toBe(true);
  });

  it("validatePending: fresh valid, expired invalid (10-min TTL)", () => {
    const record = Core.makePendingRecord({
      kind: "delete",
      unsigned: unsignedWithId(),
      returnTo: "/",
      nowSec: NOW,
    });
    expect(Core.validatePending(record, NOW)).toBe(true);
    expect(Core.validatePending(record, NOW + 599)).toBe(true);
    expect(Core.validatePending(record, NOW + 600)).toBe(true); // exactly at TTL
    expect(Core.validatePending(record, NOW + 601)).toBe(false); // past TTL
    expect(Core.validatePending(record, NOW + 3, 2)).toBe(false); // custom ttlSec
  });

  it("validatePending: wrong kind / tampered record invalid", () => {
    const record = Core.makePendingRecord({
      kind: "publish",
      unsigned: unsignedWithId(),
      returnTo: "/",
      nowSec: NOW,
    });
    expect(Core.validatePending({ ...record, kind: "install-malware" }, NOW)).toBe(false);
    expect(Core.validatePending({ ...record, ts: "yesterday" }, NOW)).toBe(false);
    expect(
      Core.validatePending(
        { ...record, unsigned: { ...record.unsigned, id: "nope" } },
        NOW,
      ),
    ).toBe(false);
    expect(Core.validatePending(null, NOW)).toBe(false);
    expect(Core.validatePending("garbage", NOW)).toBe(false);
    // A record stamped far in the future (clock rollback / tampering).
    expect(Core.validatePending({ ...record, ts: NOW + 3600 }, NOW)).toBe(false);
  });
});

describe("NbreadSignerCore.completeUnsigned", () => {
  const NOW = 1_700_000_123;

  it("fills pubkey/defaults and precomputes the NIP-01 id", () => {
    const full = Core.completeUnsigned(
      { kind: 1, content: "gm", tags: [["t", "gm"]], created_at: NOW },
      keys.alice.pk,
      NOW,
    );
    expect(full.pubkey).toBe(keys.alice.pk);
    expect(full.id).toBe(
      C.eventId({
        pubkey: keys.alice.pk,
        created_at: NOW,
        kind: 1,
        tags: [["t", "gm"]],
        content: "gm",
      }),
    );
  });

  it("defaults created_at to nowSec and tags/content to empty", () => {
    const full = Core.completeUnsigned({ kind: 22242 }, keys.bob.pk, NOW);
    expect(full.created_at).toBe(NOW);
    expect(full.tags).toEqual([]);
    expect(full.content).toBe("");
    expect(full.id).toHaveLength(64);
  });

  it("rejects events without an integer kind", () => {
    expect(() => Core.completeUnsigned({ content: "x" }, keys.alice.pk, NOW)).toThrow();
    expect(() =>
      Core.completeUnsigned({ kind: 1.5, content: "x" }, keys.alice.pk, NOW),
    ).toThrow();
  });
});
