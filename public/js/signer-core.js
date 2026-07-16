// Pure signer helpers behind the NbreadSigner dispatcher (public/js/signer.js):
// nsec/pubkey normalization, the NIP-55 (Amber) web-intent URL builder, the
// NIP-55 callback query-string parser, and the pending-record shape stashed in
// localStorage across the Amber redirect round-trip.
//
// PURE by contract: no document/window/localStorage/fetch — only
// globalThis.NbreadCrypto (public/js/vendor/nostr-crypto.js, loaded first).
// test/unit/signer-core.spec.ts imports this file for its side effect and
// exercises the global directly; keep it importable in vitest (workerd, no
// DOM). SECURITY: secret keys pass through decodeNsec only as strings/derived
// hex — nothing here performs I/O of any kind.
(function () {
  "use strict";

  var HEX_64 = /^[0-9a-f]{64}$/;

  var INTENT_TYPES = { get_public_key: true, sign_event: true };
  var PENDING_KINDS = { login: true, publish: true, delete: true };
  var DEFAULT_TTL_SEC = 600; // 10 minutes across the Amber round-trip

  // Lazy lookup so import order mistakes fail loudly at call time with a
  // clear message instead of a TypeError on a half-initialized closure.
  function cryptoApi() {
    var c = globalThis.NbreadCrypto;
    if (!c) {
      throw new Error(
        "NbreadSignerCore: NbreadCrypto missing — load public/js/vendor/nostr-crypto.js first",
      );
    }
    return c;
  }

  /**
   * Accept an "nsec1…" string or 64 hex chars (either case) and return
   * { skHex, pkHex, npub }. Throws Error on anything else — including
   * secret keys the curve rejects (zero, >= group order).
   */
  function decodeNsec(input) {
    if (typeof input !== "string") {
      throw new Error("NbreadSignerCore: secret key must be a string");
    }
    var C = cryptoApi();
    var trimmed = input.trim();
    var skHex;
    if (/^nsec1/i.test(trimmed)) {
      skHex = C.nsecDecode(trimmed);
    } else if (HEX_64.test(trimmed.toLowerCase())) {
      skHex = trimmed.toLowerCase();
    } else {
      throw new Error("NbreadSignerCore: expected an nsec1… key or 64 hex characters");
    }
    // Throws for invalid scalars — surfaces as "invalid key" to the caller.
    var pkHex = C.getPublicKeyHex(C.hexToBytes(skHex));
    return { skHex: skHex, pkHex: pkHex, npub: C.npubEncode(pkHex) };
  }

  /** Accept "npub1…" or 64 hex chars (either case); return lowercase hex. */
  function normalizePubkey(input) {
    if (typeof input !== "string") {
      throw new Error("NbreadSignerCore: pubkey must be a string");
    }
    var trimmed = input.trim();
    if (/^npub1/i.test(trimmed)) {
      return cryptoApi().npubDecode(trimmed);
    }
    var lower = trimmed.toLowerCase();
    if (HEX_64.test(lower)) return lower;
    throw new Error("NbreadSignerCore: expected an npub1… key or 64 hex characters");
  }

  /**
   * Amber (NIP-55) web-intent URL. `returnType=signature` keeps the callback
   * URL short: Amber appends only the 128-hex signature (sign_event) or the
   * pubkey (get_public_key) rather than the whole signed event. The caller
   * bakes an "…&event=" suffix into callbackUrl so Amber's appended value
   * lands in a query parameter parseNip55Callback can find.
   */
  function buildNip55Intent(opts) {
    if (!opts || !INTENT_TYPES[opts.type]) {
      throw new Error("NbreadSignerCore: intent type must be get_public_key or sign_event");
    }
    if (typeof opts.callbackUrl !== "string" || opts.callbackUrl.length === 0) {
      throw new Error("NbreadSignerCore: callbackUrl is required");
    }
    return (
      "intent:" +
      (opts.eventJson ? encodeURIComponent(opts.eventJson) : "") +
      "#Intent;scheme=nostrsigner;S.compressionType=none;S.returnType=signature;S.type=" +
      opts.type +
      ";S.appName=nbread;S.callbackUrl=" +
      opts.callbackUrl +
      ";end"
    );
  }

  // Parameters Amber (across versions) has used to carry the result, in
  // priority order. "event" is what our own callbackUrl suffix names.
  var CALLBACK_PARAMS = ["event", "sig", "signature", "result", "pubkey", "npub"];

  /**
   * Parse the query string Amber redirected back with. Returns
   * { kind: "sign" | "pubkey" | null, value: string | null } — `value` is the
   * raw appended payload (128-hex sig, or npub/hex pubkey); the caller
   * reassembles the signed event. A URL counts as a NIP-55 callback ONLY when
   * it carries our explicit "nip55" marker (signer.js always bakes it into
   * the callbackUrl it hands Amber) — bare ?pubkey=/?sig=/… params on an
   * innocent link must never trigger the resume path. Once the marker is
   * present, the result value is still extracted tolerantly across the param
   * names different Amber versions append.
   */
  function parseNip55Callback(search) {
    if (typeof search !== "string" || search === "" || search === "?") {
      return { kind: null, value: null };
    }
    var params = new URLSearchParams(search.charAt(0) === "?" ? search.slice(1) : search);

    // Our own marker (baked into callbackUrl) names the flow explicitly.
    // No marker => not a NIP-55 callback, regardless of other params.
    var marker = params.get("nip55");
    var kind = null;
    if (marker === "sign" || marker === "sign_event") kind = "sign";
    else if (marker === "pubkey" || marker === "get_public_key") kind = "pubkey";
    if (kind === null) return { kind: null, value: null };

    var value = null;
    for (var i = 0; i < CALLBACK_PARAMS.length; i++) {
      var v = params.get(CALLBACK_PARAMS[i]);
      if (v) {
        value = v;
        break;
      }
    }
    return { kind: kind, value: value };
  }

  /** True when `unsigned` already carries a precomputed 64-hex pubkey and id. */
  function hasPrecomputedId(unsigned) {
    return (
      !!unsigned &&
      typeof unsigned === "object" &&
      typeof unsigned.pubkey === "string" &&
      HEX_64.test(unsigned.pubkey) &&
      typeof unsigned.id === "string" &&
      HEX_64.test(unsigned.id)
    );
  }

  /**
   * Record stashed in localStorage ("nbread:nip55:pending") before navigating
   * to the Amber intent. `unsigned` must already have pubkey + id computed
   * (so the returned signature can be verified against them), or be null for
   * a get_public_key round-trip. `returnTo` is where the UI resumes.
   */
  function makePendingRecord(opts) {
    if (!opts || !PENDING_KINDS[opts.kind]) {
      throw new Error("NbreadSignerCore: pending kind must be login, publish or delete");
    }
    if (typeof opts.nowSec !== "number" || !isFinite(opts.nowSec)) {
      throw new Error("NbreadSignerCore: nowSec must be a number");
    }
    var unsigned = opts.unsigned === undefined ? null : opts.unsigned;
    if (unsigned !== null && !hasPrecomputedId(unsigned)) {
      throw new Error(
        "NbreadSignerCore: pending unsigned event must have pubkey and id precomputed",
      );
    }
    return {
      kind: opts.kind,
      unsigned: unsigned,
      returnTo: typeof opts.returnTo === "string" ? opts.returnTo : "",
      ts: Math.floor(opts.nowSec),
    };
  }

  /**
   * A pending record is valid when its kind is known, its timestamp is within
   * ttlSec (default 600 = 10 min) of nowSec, and its unsigned event — when it
   * has one — still carries the precomputed pubkey + id. Timestamps from the
   * future are rejected too (clock rollback / tampered storage).
   */
  function validatePending(record, nowSec, ttlSec) {
    var ttl = typeof ttlSec === "number" ? ttlSec : DEFAULT_TTL_SEC;
    if (!record || typeof record !== "object") return false;
    if (!PENDING_KINDS[record.kind]) return false;
    if (typeof record.ts !== "number" || !isFinite(record.ts)) return false;
    if (typeof nowSec !== "number" || !isFinite(nowSec)) return false;
    if (record.ts > nowSec + 60) return false; // allow a minute of clock skew
    if (nowSec - record.ts > ttl) return false;
    if (record.unsigned !== null && record.unsigned !== undefined) {
      if (!hasPrecomputedId(record.unsigned)) return false;
    }
    return true;
  }

  /**
   * Fill in pubkey / defaults and precompute the NIP-01 id for an event about
   * to be signed out-of-page (NIP-55). `created_at` falls back to nowSec so
   * the id stays deterministic across the redirect round-trip.
   */
  function completeUnsigned(unsigned, pubkeyHex, nowSec) {
    if (!unsigned || typeof unsigned !== "object") {
      throw new Error("NbreadSignerCore: unsigned event must be an object");
    }
    if (typeof unsigned.kind !== "number" || !Number.isInteger(unsigned.kind)) {
      throw new Error("NbreadSignerCore: unsigned event needs an integer kind");
    }
    var createdAt =
      typeof unsigned.created_at === "number" ? unsigned.created_at : nowSec;
    if (typeof createdAt !== "number" || !isFinite(createdAt)) {
      throw new Error("NbreadSignerCore: unsigned event needs created_at (or pass nowSec)");
    }
    var evt = {
      pubkey: normalizePubkey(unsigned.pubkey || pubkeyHex),
      created_at: Math.floor(createdAt),
      kind: unsigned.kind,
      tags: Array.isArray(unsigned.tags) ? unsigned.tags : [],
      content: typeof unsigned.content === "string" ? unsigned.content : "",
    };
    evt.id = cryptoApi().eventId(evt);
    return evt;
  }

  var api = {
    decodeNsec: decodeNsec,
    normalizePubkey: normalizePubkey,
    buildNip55Intent: buildNip55Intent,
    parseNip55Callback: parseNip55Callback,
    makePendingRecord: makePendingRecord,
    validatePending: validatePending,
    completeUnsigned: completeUnsigned,
  };

  Object.freeze(api);
  globalThis.NbreadSignerCore = api;
})();
