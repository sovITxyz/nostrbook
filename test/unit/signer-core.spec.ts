// Packet B: the pure signer core (public/js/signer-core.js) behind the
// NbreadSigner dispatcher. The IIFE is imported for its side effect (it
// assigns globalThis.NbreadSignerCore) and exercised directly against the
// committed crypto vendor bundle. signer.js itself is deliberately NOT
// imported here — it touches window/localStorage/location and cannot load in
// workerd.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  finalizeEvent: (
    unsigned: Partial<Unsigned>,
    skBytes: Uint8Array,
  ) => Unsigned & { id: string; sig: string };
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

  it("tolerates alternate result params across Amber versions once marked", () => {
    // With the nip55 marker present, the value is extracted from whichever
    // param this Amber version appended.
    expect(Core.parseNip55Callback(`?nip55=sign&sig=${SIG_128}`)).toEqual({
      kind: "sign",
      value: SIG_128,
    });
    expect(Core.parseNip55Callback(`?nip55=sign&signature=${SIG_128}`)).toEqual({
      kind: "sign",
      value: SIG_128,
    });
    expect(Core.parseNip55Callback(`?nip55=pubkey&result=${keys.bob.pk}`)).toEqual({
      kind: "pubkey",
      value: keys.bob.pk,
    });
    const npub = C.npubEncode(keys.bob.pk);
    expect(Core.parseNip55Callback(`?nip55=pubkey&pubkey=${npub}`)).toEqual({
      kind: "pubkey",
      value: npub,
    });
    // Long-form marker values still name the flow.
    expect(Core.parseNip55Callback(`?nip55=sign_event&event=${SIG_128}`)).toEqual({
      kind: "sign",
      value: SIG_128,
    });
    expect(
      Core.parseNip55Callback(`?nip55=get_public_key&event=${keys.bob.pk}`),
    ).toEqual({ kind: "pubkey", value: keys.bob.pk });
  });

  it("ignores marker-less URLs even when they carry result-shaped params", () => {
    // Regression: an innocent link with ?pubkey=/?sig=/… must NOT be treated
    // as a NIP-55 callback (it would consume/strip signer state).
    const none = { kind: null, value: null };
    expect(Core.parseNip55Callback(`?sig=${SIG_128}`)).toEqual(none);
    expect(Core.parseNip55Callback(`?signature=${SIG_128}`)).toEqual(none);
    expect(Core.parseNip55Callback(`?event=${SIG_128}`)).toEqual(none);
    expect(Core.parseNip55Callback(`?result=${keys.bob.pk}`)).toEqual(none);
    expect(Core.parseNip55Callback(`?pubkey=${keys.bob.pk}`)).toEqual(none);
    expect(Core.parseNip55Callback(`?npub=${C.npubEncode(keys.bob.pk)}`)).toEqual(none);
    // Unknown marker values do not count either.
    expect(Core.parseNip55Callback(`?nip55=wat&event=${SIG_128}`)).toEqual(none);
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

// --- NbreadSigner.resumePending: callback-type <-> pending-record binding ----
//
// signer.js touches window/localStorage/location, so (like signer-nip46.spec)
// it is imported dynamically in beforeAll after minimal shims are installed —
// static imports hoist above module-body statements. `history` stays
// undefined; stripCallbackParams swallows that (cosmetic only).
describe("NbreadSigner.resumePending (NIP-55 callback binding)", () => {
  const KEY_PENDING = "nbread:nip55:pending";
  const KEY_NIP55 = "nbread:signer:nip55";
  const KEY_METHOD = "nbread:signer:method";

  const store = new Map<string, string>();
  const loc = {
    href: "https://nbread.lol/login",
    origin: "https://nbread.lol",
    pathname: "/login",
    search: "",
  };

  type ResumeResult = {
    kind: string | null;
    unsigned: unknown;
    signed?: Record<string, unknown>;
    pubkey?: string;
    error?: string;
  } | null;

  let Signer: { resumePending: () => ResumeResult };

  beforeAll(async () => {
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    };
    (globalThis as any).location = loc;
    // @ts-ignore — plain browser IIFE, intentionally shipped without types
    await import("../../public/js/signer.js");
    Signer = (globalThis as any).NbreadSigner;
  });

  beforeEach(() => {
    store.clear();
    setSearch("");
  });

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }
  function stash(record: unknown) {
    store.set(KEY_PENDING, JSON.stringify(record));
  }
  function setSearch(search: string) {
    loc.search = search;
    loc.href = "https://nbread.lol/login" + search;
  }
  function signFlowUnsigned() {
    const unsigned: Unsigned = {
      pubkey: keys.alice.pk,
      created_at: 1_700_000_000,
      kind: 1,
      tags: [],
      content: "hi",
    };
    return { ...unsigned, id: C.eventId(unsigned) };
  }

  it("returns null and leaves all state alone on a marker-less URL", () => {
    stash({ kind: "login", unsigned: null, returnTo: "/login", ts: nowSec() });
    setSearch(`?pubkey=${keys.alice.pk}`);
    expect(Signer.resumePending()).toBeNull();
    expect(store.has(KEY_PENDING)).toBe(true); // NOT consumed
    expect(store.has(KEY_NIP55)).toBe(false);
    expect(store.has(KEY_METHOD)).toBe(false);
  });

  it("completes a legitimate get_public_key round-trip and persists the pubkey", () => {
    stash({ kind: "login", unsigned: null, returnTo: "/login", ts: nowSec() });
    setSearch(`?nip55=pubkey&event=${keys.alice.pk}`);
    const res = Signer.resumePending();
    expect(res).toEqual({ kind: "login", unsigned: null, pubkey: keys.alice.pk });
    expect(store.has(KEY_PENDING)).toBe(false); // one shot
    expect(JSON.parse(store.get(KEY_NIP55)!)).toEqual({ pkHex: keys.alice.pk });
    expect(store.get(KEY_METHOD)).toBe("nip55");
  });

  it("completes a legitimate sign_event round-trip (contract shape unchanged)", () => {
    const full = signFlowUnsigned();
    // finalizeEvent rederives pubkey/id from the same fields, so its sig is
    // exactly what Amber would append for this stashed unsigned event.
    const signed = C.finalizeEvent(full, C.hexToBytes(keys.alice.sk));
    stash({ kind: "publish", unsigned: full, returnTo: "/write", ts: nowSec() });
    setSearch(`?nip55=sign&event=${signed.sig}`);
    const res = Signer.resumePending();
    expect(res?.error).toBeUndefined();
    expect(res?.kind).toBe("publish");
    expect(res?.signed).toEqual({ ...full, sig: signed.sig });
  });

  it("rejects a sign callback against a pubkey-flow pending record and consumes it", () => {
    stash({ kind: "login", unsigned: null, returnTo: "/login", ts: nowSec() });
    setSearch(`?nip55=sign&event=${SIG_128}`);
    const res = Signer.resumePending();
    expect(res?.error).toBe("unexpected signer callback");
    expect(res?.signed).toBeUndefined();
    expect(res?.pubkey).toBeUndefined();
    expect(store.has(KEY_PENDING)).toBe(false); // consumed even on rejection
    expect(store.has(KEY_NIP55)).toBe(false);
    expect(store.has(KEY_METHOD)).toBe(false);
  });

  it("rejects a pubkey callback against a sign-flow pending record — nothing persisted", () => {
    stash({ kind: "publish", unsigned: signFlowUnsigned(), returnTo: "/write", ts: nowSec() });
    setSearch(`?nip55=pubkey&event=${keys.mallory.pk}`);
    const res = Signer.resumePending();
    expect(res?.error).toBe("unexpected signer callback");
    expect(res?.pubkey).toBeUndefined();
    expect(store.has(KEY_PENDING)).toBe(false);
    expect(store.has(KEY_NIP55)).toBe(false); // attacker pubkey never stored
    expect(store.has(KEY_METHOD)).toBe(false);
  });

  it("never persists a pubkey when no pending record exists at all", () => {
    setSearch(`?nip55=pubkey&event=${keys.mallory.pk}`);
    const res = Signer.resumePending();
    expect(res?.error).toMatch(/expired/);
    expect(store.has(KEY_NIP55)).toBe(false);
    expect(store.has(KEY_METHOD)).toBe(false);
  });
});
