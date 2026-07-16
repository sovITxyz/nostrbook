// NbreadSigner — the one signing seam every page-level script talks to.
// Dispatches to one of four backends chosen by the persisted method:
//   nip07  — window.nostr browser extension (Alby, nos2x, …)
//   local  — nsec pasted by the user, kept in localStorage, signs IN-PAGE
//   nip55  — Amber on Android via intent: redirects (page unload + callback)
//   nip46  — remote bunker; the backend object is registered at load time by
//            public/js/signer-nip46.js via NbreadSigner.register("nip46", …)
//
// Load order (classic <script> includes, no modules):
//   vendor/nostr-crypto.js -> signer-core.js -> signer.js [-> signer-nip46.js]
//
// SECURITY: the local backend's secret key is used ONLY as input to
// NbreadCrypto.finalizeEvent, in-page. It must never appear in any fetch /
// WebSocket / URL / intent payload — nothing in this file sends it anywhere.
//
// This file may touch window/localStorage/location/history and is therefore
// NOT imported by unit tests; the pure logic lives in signer-core.js.
(function () {
  "use strict";

  var KEY_METHOD = "nbread:signer:method";
  var KEY_NSEC = "nbread:signer:nsec"; // {skHex, pkHex} — plain (product decision)
  var KEY_NIP55 = "nbread:signer:nip55"; // {pkHex}
  var KEY_NIP46 = "nbread:signer:nip46"; // owned/written by signer-nip46.js
  var KEY_PENDING = "nbread:nip55:pending"; // {kind, unsigned, returnTo, ts}

  var METHODS = { nip07: true, nip46: true, nip55: true, local: true };

  function core() {
    return globalThis.NbreadSignerCore;
  }
  function cryptoApi() {
    return globalThis.NbreadCrypto;
  }
  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  function readJson(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null; // corrupted storage reads as "not configured"
    }
  }
  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  // Externally registered backends (nip46 plugs in here). A backend is
  // { ready, getPublicKey, signEvent, configure } and may add forget().
  var registered = {};

  // signer-nip46.js registers itself only when it loads AFTER this file. If
  // the <script> tags were ever reversed it still exposes its backend on
  // globalThis.NbreadNip46 — pick that up lazily so load order is never a
  // silent foot-gun.
  function nip46Backend() {
    if (!registered.nip46) {
      var ext = globalThis.NbreadNip46;
      if (ext && ext.backend) registered.nip46 = ext.backend;
    }
    return registered.nip46 || null;
  }

  function method() {
    var m = localStorage.getItem(KEY_METHOD);
    return m && METHODS[m] ? m : null;
  }

  function setMethod(m) {
    if (!METHODS[m]) throw new Error("NbreadSigner: unknown method " + m);
    localStorage.setItem(KEY_METHOD, m);
  }

  /**
   * Clear a backend's stored state; when it was the active method (or no
   * argument is given), clear the active method too so method() returns null.
   */
  function forget(m) {
    var target = m || method();
    if (target === "local") {
      localStorage.removeItem(KEY_NSEC);
    } else if (target === "nip55") {
      localStorage.removeItem(KEY_NIP55);
      localStorage.removeItem(KEY_PENDING);
    } else if (target === "nip46") {
      var b = nip46Backend();
      if (b && typeof b.forget === "function") b.forget();
      localStorage.removeItem(KEY_NIP46);
    }
    // nip07 has no stored state beyond the method selection itself.
    if (method() === target) localStorage.removeItem(KEY_METHOD);
  }

  // --- NIP-55 (Amber) redirect plumbing --------------------------------------

  // Map an event kind to the pending-record intent bucket the resume UI
  // routes on. 22242 = NIP-42-style auth (login); 5 = NIP-09 deletion.
  function pendingKindFor(eventKind) {
    if (eventKind === 22242) return "login";
    if (eventKind === 5) return "delete";
    return "publish";
  }

  // Callback URL Amber redirects back to. The trailing "&event=" is
  // deliberate: with returnType=signature Amber appends the raw result
  // directly to callbackUrl, so it lands in the `event` query parameter.
  // Existing query params are dropped (returnTo in the pending record
  // preserves the full URL); the origin comes from location, keeping the
  // callback same-site by construction.
  function nip55CallbackUrl(flow) {
    return (
      location.origin + location.pathname + "?nip55=" + flow + "&event="
    );
  }

  function stashPendingAndGo(kind, unsigned, intentUrl) {
    var record = core().makePendingRecord({
      kind: kind,
      unsigned: unsigned,
      returnTo: location.href,
      nowSec: nowSec(),
    });
    writeJson(KEY_PENDING, record);
    // Full navigation into the Amber app; this page unloads. The promise the
    // caller holds intentionally never settles — resumePending() picks the
    // flow back up after the redirect.
    location.href = intentUrl;
    return new Promise(function () {});
  }

  // Remove the NIP-55 callback params from the address bar so a reload never
  // replays a consumed signature.
  function stripCallbackParams() {
    try {
      var url = new URL(location.href);
      var drop = ["nip55", "event", "sig", "signature", "result", "pubkey", "npub"];
      for (var i = 0; i < drop.length; i++) url.searchParams.delete(drop[i]);
      history.replaceState(history.state, "", url.pathname + (url.search || "") + url.hash);
    } catch (_) {
      /* history unavailable — cosmetic only */
    }
  }

  /**
   * Called once on page load by the resume UI. If the URL carries a NIP-55
   * callback: consume the pending record (always cleared), strip the params,
   * and return { kind, unsigned, signed?, pubkey?, error? } — `signed` for a
   * completed sign_event (schnorr-verified against the precomputed id +
   * pubkey), `pubkey` for a completed get_public_key (also persisted via
   * configureNip55), `error` on cancel/expiry/verification failure.
   * Returns null when the URL has no callback.
   */
  function resumePending() {
    var parsed = core().parseNip55Callback(location.search);
    if (parsed.kind === null) return null;

    var record = readJson(KEY_PENDING);
    localStorage.removeItem(KEY_PENDING); // one shot, even on failure
    stripCallbackParams();

    if (!core().validatePending(record, nowSec())) {
      return {
        kind: record ? record.kind : null,
        unsigned: record ? record.unsigned : null,
        error: "This signing request expired — please try again.",
      };
    }
    if (!parsed.value) {
      return { kind: record.kind, unsigned: record.unsigned, error: "Signing was cancelled." };
    }

    if (parsed.kind === "pubkey") {
      var pkHex;
      try {
        pkHex = core().normalizePubkey(parsed.value);
      } catch (_) {
        return {
          kind: record.kind,
          unsigned: record.unsigned,
          error: "The signer returned an unusable public key.",
        };
      }
      configureNip55(pkHex);
      return { kind: record.kind, unsigned: record.unsigned, pubkey: pkHex };
    }

    // sign_event: reassemble unsigned + sig and verify before trusting it.
    // The stored id is recomputed from the stored fields first: schnorrVerify
    // only proves the sig covers unsigned.id, not that unsigned.id covers the
    // stored kind/tags/content — a tampered record must not verify.
    var unsigned = record.unsigned;
    var sig = String(parsed.value).trim().toLowerCase();
    if (
      !unsigned ||
      !/^[0-9a-f]{128}$/.test(sig) ||
      cryptoApi().eventId(unsigned) !== unsigned.id ||
      !cryptoApi().schnorrVerify(sig, unsigned.id, unsigned.pubkey)
    ) {
      return {
        kind: record.kind,
        unsigned: unsigned,
        error: "The returned signature did not verify — nothing was published.",
      };
    }
    return {
      kind: record.kind,
      unsigned: unsigned,
      signed: {
        id: unsigned.id,
        pubkey: unsigned.pubkey,
        kind: unsigned.kind,
        created_at: unsigned.created_at,
        tags: unsigned.tags,
        content: unsigned.content,
        sig: sig,
      },
    };
  }

  // --- Backends ---------------------------------------------------------------

  var backends = {
    nip07: {
      ready: function () {
        var ok =
          typeof window !== "undefined" &&
          window.nostr &&
          typeof window.nostr.signEvent === "function";
        return Promise.resolve(
          ok
            ? { ok: true }
            : { ok: false, reason: "No NIP-07 extension (window.nostr) found." },
        );
      },
      getPublicKey: function () {
        return Promise.resolve(window.nostr.getPublicKey());
      },
      signEvent: function (unsigned) {
        return Promise.resolve(window.nostr.signEvent(unsigned));
      },
    },

    local: {
      ready: function () {
        var stored = readJson(KEY_NSEC);
        return Promise.resolve(
          stored && stored.skHex
            ? { ok: true }
            : { ok: false, reason: "No local key stored." },
        );
      },
      getPublicKey: function () {
        var stored = readJson(KEY_NSEC);
        if (!stored || !stored.pkHex) {
          return Promise.reject(new Error("NbreadSigner: no local key stored"));
        }
        return Promise.resolve(stored.pkHex);
      },
      signEvent: function (unsigned) {
        var stored = readJson(KEY_NSEC);
        if (!stored || !stored.skHex) {
          return Promise.reject(new Error("NbreadSigner: no local key stored"));
        }
        try {
          // IN-PAGE signing: the secret key goes into finalizeEvent and
          // nowhere else — never into any network call.
          var skBytes = cryptoApi().hexToBytes(stored.skHex);
          return Promise.resolve(cryptoApi().finalizeEvent(unsigned, skBytes));
        } catch (e) {
          return Promise.reject(e);
        }
      },
    },

    nip55: {
      ready: function () {
        var stored = readJson(KEY_NIP55);
        return Promise.resolve(
          stored && stored.pkHex
            ? { ok: true }
            : { ok: false, reason: "Amber is not connected yet." },
        );
      },
      getPublicKey: function () {
        var stored = readJson(KEY_NIP55);
        if (stored && stored.pkHex) return Promise.resolve(stored.pkHex);
        // No stored pubkey: redirect round-trip to Amber's get_public_key.
        var intentUrl = core().buildNip55Intent({
          type: "get_public_key",
          callbackUrl: nip55CallbackUrl("pubkey"),
        });
        return stashPendingAndGo("login", null, intentUrl);
      },
      signEvent: function (unsigned) {
        var stored = readJson(KEY_NIP55);
        if (!stored || !stored.pkHex) {
          return Promise.reject(
            new Error("NbreadSigner: connect Amber (get_public_key) before signing"),
          );
        }
        var full;
        try {
          full = core().completeUnsigned(unsigned, stored.pkHex, nowSec());
        } catch (e) {
          return Promise.reject(e);
        }
        var intentUrl = core().buildNip55Intent({
          type: "sign_event",
          callbackUrl: nip55CallbackUrl("sign"),
          eventJson: JSON.stringify(full),
        });
        return stashPendingAndGo(pendingKindFor(full.kind), full, intentUrl);
      },
    },
  };

  function activeBackend() {
    var m = method();
    if (!m) return null;
    if (m === "nip46") return nip46Backend();
    return backends[m];
  }

  // --- Dispatcher API -----------------------------------------------------------

  function ready() {
    var m = method();
    if (!m) return Promise.resolve({ ok: false, reason: "No signer configured." });
    if (m === "nip46") {
      var b = nip46Backend();
      if (!b) return Promise.resolve({ ok: false, reason: "NIP-46 not loaded" });
      return Promise.resolve(b.ready());
    }
    return backends[m].ready();
  }

  function getPublicKey() {
    var b = activeBackend();
    if (!b) return Promise.reject(new Error("NbreadSigner: no signer configured"));
    return b.getPublicKey();
  }

  /**
   * Sign an unsigned event with the configured backend. NOTE: with the nip55
   * method this navigates away to Amber and the returned promise never
   * settles — check isRedirectSigner() first and design the flow around
   * resumePending().
   */
  function signEvent(unsigned) {
    var b = activeBackend();
    if (!b) return Promise.reject(new Error("NbreadSigner: no signer configured"));
    return b.signEvent(unsigned);
  }

  function isRedirectSigner() {
    return method() === "nip55";
  }

  /** Store a pasted nsec/hex key and switch to the local backend. */
  function configureLocal(nsecOrHex) {
    var decoded = core().decodeNsec(nsecOrHex);
    writeJson(KEY_NSEC, { skHex: decoded.skHex, pkHex: decoded.pkHex });
    setMethod("local");
    return { pkHex: decoded.pkHex, npub: decoded.npub };
  }

  /** Store the Amber-provided pubkey and switch to the nip55 backend. */
  function configureNip55(pubkeyHexOrNpub) {
    var pkHex = core().normalizePubkey(pubkeyHexOrNpub);
    writeJson(KEY_NIP55, { pkHex: pkHex });
    setMethod("nip55");
  }

  /**
   * Delegate to the registered nip46 backend (signer-nip46.js). `opts`
   * ({onAuthUrl, timeoutSec, transport}) is forwarded — for a bunker:// URI
   * string it is the ONLY carrier for the auth-url approval callback.
   */
  function configureNip46(uri, opts) {
    var b = nip46Backend();
    if (!b || typeof b.configure !== "function") {
      return Promise.reject(new Error("NbreadSigner: NIP-46 not loaded"));
    }
    return Promise.resolve(b.configure(uri, opts)).then(function (result) {
      setMethod("nip46");
      return result; // {userPubkey}
    });
  }

  /** Plug in an external backend object ({ready,getPublicKey,signEvent,configure}). */
  function register(name, backend) {
    registered[name] = backend;
  }

  var api = {
    method: method,
    setMethod: setMethod,
    forget: forget,
    ready: ready,
    getPublicKey: getPublicKey,
    signEvent: signEvent,
    isRedirectSigner: isRedirectSigner,
    resumePending: resumePending,
    configureNip46: configureNip46,
    configureLocal: configureLocal,
    configureNip55: configureNip55,
    register: register,
  };

  Object.freeze(api);
  globalThis.NbreadSigner = api;
})();
