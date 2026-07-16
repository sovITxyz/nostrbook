// NIP-46 remote-signer client (Amber, nsec.app, any bunker:// signer).
//
// Load order: after vendor/nostr-crypto.js (hard dependency) and, when the
// signer registry is in use, after signer.js — on load this file calls
// NbreadSigner.register("nip46", backend) if the registry exists.
//
// Two layers, deliberately separated:
//   1. globalThis.NbreadNip46 — the PURE surface: bunker://
//      parsing, nostrconnect:// building, the encrypted request/response
//      envelope, and a transport-INJECTABLE state machine (createClient).
//      Nothing in this layer touches sockets, DOM, or localStorage, so it
//      imports cleanly in vitest (workerd) and is unit-tested with a
//      scripted fake transport.
//   2. The registered backend + the real-WebSocket transport adapter:
//      pairing (configure), persistence under "nbread:signer:nip46", and
//      per-sign socket sessions. Browser-only; every environment touch is
//      guarded so the file still imports where localStorage/WebSocket do
//      not exist.
//
// Protocol notes (NIP-46):
//   - Requests/responses ride kind-24133 events; content is
//     NIP-44-encrypted JSON {id, method, params} / {id, result, error}.
//   - Some older signers answer with NIP-04 (content contains "?iv=") —
//     decodeResponse auto-detects, and the client falls back to NIP-04 for
//     subsequent requests (plus one connect retry on decrypt failure).
//   - {result:"auth_url", error:<url>} means "the user must approve in a
//     browser": the url is surfaced via a callback, never auto-navigated.
//   - Signed events returned by the signer are NEVER trusted by shape: the
//     client recomputes the NIP-01 id and schnorr-verifies the signature
//     before handing the event to anyone.
(function () {
  "use strict";

  var C = globalThis.NbreadCrypto;
  if (!C) {
    throw new Error(
      "signer-nip46.js requires vendor/nostr-crypto.js to be loaded first",
    );
  }

  var NIP46_KIND = 24133;
  var HEX64 = /^[0-9a-f]{64}$/;
  var STORAGE_KEY = "nbread:signer:nip46";
  var METHOD_KEY = "nbread:signer:method";
  var DEFAULT_TIMEOUT_SEC = 60;
  var DEFAULT_PAIRING_TIMEOUT_SEC = 120;

  // -------------------------------------------------------------------------
  // Pure helpers: URI codecs
  // -------------------------------------------------------------------------

  /** Throw unless every entry is a wss:// URL (ws://, http(s):// rejected). */
  function assertWssRelays(relays) {
    for (var i = 0; i < relays.length; i++) {
      var r = relays[i];
      if (typeof r !== "string" || r.length <= 6 || r.slice(0, 6).toLowerCase() !== "wss://") {
        throw new Error("nip46: relay must be a wss:// URL, got: " + String(r));
      }
    }
  }

  /**
   * Parse "bunker://<64-hex-pubkey>?relay=wss://..&relay=..&secret=..".
   * Returns {remoteSignerPubkey, relays, secret?}. Throws on a non-hex
   * pubkey, zero relays, or any non-wss relay.
   */
  function parseBunkerUri(uri) {
    if (typeof uri !== "string" || uri.slice(0, 9).toLowerCase() !== "bunker://") {
      throw new Error("nip46: not a bunker:// URI");
    }
    var rest = uri.slice(9);
    var q = rest.indexOf("?");
    var pubkey = (q === -1 ? rest : rest.slice(0, q)).replace(/\/$/, "").toLowerCase();
    if (!HEX64.test(pubkey)) {
      throw new Error("nip46: bunker URI must carry a 64-char hex remote-signer pubkey");
    }
    var relays = [];
    var secret;
    if (q !== -1) {
      var parts = rest.slice(q + 1).split("&");
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        var eq = parts[i].indexOf("=");
        if (eq === -1) continue;
        var key = parts[i].slice(0, eq);
        var value;
        try {
          value = decodeURIComponent(parts[i].slice(eq + 1));
        } catch (_e) {
          throw new Error("nip46: malformed percent-encoding in bunker URI");
        }
        if (key === "relay") relays.push(value);
        else if (key === "secret") secret = value;
      }
    }
    if (!relays.length) {
      throw new Error("nip46: bunker URI must name at least one wss:// relay");
    }
    assertWssRelays(relays);
    var out = { remoteSignerPubkey: pubkey, relays: relays };
    if (typeof secret === "string" && secret) out.secret = secret;
    return out;
  }

  /**
   * Build the client-initiated pairing URI:
   * "nostrconnect://<clientPubkey>?relay=..&secret=..&name=nbread".
   * Rendered as copyable text for the user to paste into their signer.
   */
  function buildNostrconnectUri(opts) {
    if (!opts || typeof opts !== "object") {
      throw new Error("nip46: buildNostrconnectUri needs {clientPubkey, relays, secret}");
    }
    var pk = String(opts.clientPubkey || "").toLowerCase();
    if (!HEX64.test(pk)) {
      throw new Error("nip46: clientPubkey must be 64 hex chars");
    }
    if (!Array.isArray(opts.relays) || !opts.relays.length) {
      throw new Error("nip46: at least one wss:// relay required");
    }
    assertWssRelays(opts.relays);
    if (typeof opts.secret !== "string" || !opts.secret) {
      throw new Error("nip46: nostrconnect requires a secret");
    }
    var name = typeof opts.name === "string" && opts.name ? opts.name : "nbread";
    var params = [];
    for (var i = 0; i < opts.relays.length; i++) {
      params.push("relay=" + encodeURIComponent(opts.relays[i]));
    }
    params.push("secret=" + encodeURIComponent(opts.secret));
    params.push("name=" + encodeURIComponent(name));
    return "nostrconnect://" + pk + "?" + params.join("&");
  }

  // -------------------------------------------------------------------------
  // Pure helpers: encrypted request/response envelope
  // -------------------------------------------------------------------------

  /** NIP-44-encrypt a {id, method, params} request for the remote signer. */
  function encodeRequest(convKey, req) {
    if (!req || typeof req !== "object") {
      throw new Error("nip46: encodeRequest needs {id, method, params}");
    }
    if (typeof req.id !== "string" && typeof req.id !== "number") {
      throw new Error("nip46: request id must be a string or number");
    }
    if (typeof req.method !== "string" || !req.method) {
      throw new Error("nip46: request method must be a non-empty string");
    }
    if (!Array.isArray(req.params)) {
      throw new Error("nip46: request params must be an array");
    }
    return C.nip44Encrypt(
      convKey,
      JSON.stringify({ id: req.id, method: req.method, params: req.params }),
    );
  }

  /**
   * Decrypt + parse a response content string to {id, result?, error?}.
   * Auto-detects the encryption: "?iv=" means legacy NIP-04 (needs
   * nip04Keys = {skBytes, peerPubkey} because NIP-04 derives from the raw
   * keypair, not the NIP-44 conversation key); anything else is NIP-44.
   * Always returns a Promise (NIP-04 decryption is async).
   */
  async function decodeResponse(convKey, content, nip04Keys) {
    if (typeof content !== "string" || !content) {
      throw new Error("nip46: empty response content");
    }
    var plain;
    if (content.indexOf("?iv=") !== -1) {
      if (!nip04Keys || !nip04Keys.skBytes || typeof nip04Keys.peerPubkey !== "string") {
        throw new Error("nip46: nip04 response needs nip04Keys {skBytes, peerPubkey}");
      }
      plain = await C.nip04Decrypt(nip04Keys.skBytes, nip04Keys.peerPubkey, content);
    } else {
      plain = C.nip44Decrypt(convKey, content);
    }
    var msg = JSON.parse(plain);
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      throw new Error("nip46: response is not an object");
    }
    return msg;
  }

  /**
   * Authenticate an incoming relay event: the NIP-01 id must recompute from
   * its fields and the schnorr signature must verify against ev.pubkey.
   * Without this, ev.pubkey is a free-text field any relay can forge.
   */
  function verifyEnvelope(ev) {
    return (
      !!ev &&
      typeof ev.id === "string" &&
      typeof ev.pubkey === "string" &&
      typeof ev.sig === "string" &&
      typeof ev.kind === "number" &&
      typeof ev.created_at === "number" &&
      Array.isArray(ev.tags) &&
      typeof ev.content === "string" &&
      C.eventId({
        pubkey: ev.pubkey,
        created_at: ev.created_at,
        kind: ev.kind,
        tags: ev.tags,
        content: ev.content,
      }) === ev.id &&
      C.schnorrVerify(ev.sig, ev.id, ev.pubkey)
    );
  }

  // -------------------------------------------------------------------------
  // Pure state machine: createClient (transport-injectable, no sockets)
  // -------------------------------------------------------------------------

  /**
   * NIP-46 request/response client over an injected transport:
   *   transport = { send(relayUrl, frame), onMessage(cb), close() }
   * where frames are already-parsed relay message arrays
   * (["EVENT",e] / ["REQ",subId,filter] out; ["EVENT",subId,e] in).
   *
   * options: {
   *   transport, clientSkHex, remoteSignerPubkey, relays, secret?,
   *   nowSec?, timeoutSec?, setTimeoutFn?, clearTimeoutFn?,   // injectable clock
   *   onAuthUrl?(url, requestId),                             // never auto-navigates
   *   legacyNip04?,                                           // start in NIP-04 mode
   * }
   *
   * Returns { clientPubkey, start, close, connect, get_public_key,
   *           sign_event, isLegacyNip04 }.
   */
  function createClient(options) {
    if (!options || !options.transport) {
      throw new Error("nip46: createClient needs an injected transport");
    }
    var transport = options.transport;
    var clientSk = C.hexToBytes(options.clientSkHex);
    if (clientSk.length !== 32) {
      throw new Error("nip46: clientSkHex must be 64 hex chars");
    }
    var clientPubkey = C.getPublicKeyHex(clientSk);
    var remotePk = String(options.remoteSignerPubkey || "").toLowerCase();
    if (!HEX64.test(remotePk)) {
      throw new Error("nip46: remoteSignerPubkey must be 64 hex chars");
    }
    var relays = Array.isArray(options.relays) ? options.relays.slice() : [];
    if (!relays.length) {
      throw new Error("nip46: at least one relay required");
    }
    var nowSec =
      typeof options.nowSec === "function"
        ? options.nowSec
        : function () {
            return Math.floor(Date.now() / 1000);
          };
    var setTimeoutFn =
      options.setTimeoutFn ||
      function (fn, ms) {
        return setTimeout(fn, ms);
      };
    var clearTimeoutFn =
      options.clearTimeoutFn ||
      function (handle) {
        clearTimeout(handle);
      };
    var timeoutMs =
      (typeof options.timeoutSec === "number" && options.timeoutSec > 0
        ? options.timeoutSec
        : DEFAULT_TIMEOUT_SEC) * 1000;
    var onAuthUrl = typeof options.onAuthUrl === "function" ? options.onAuthUrl : null;
    var defaultSecret = typeof options.secret === "string" ? options.secret : "";
    var convKey = C.nip44ConversationKey(clientSk, remotePk);
    var legacyNip04 = options.legacyNip04 === true;
    var pending = new Map(); // id -> {resolve, reject, method, params, timer, retriedNip04}
    var started = false;
    var closed = false;
    var subId = "nbread46-" + clientPubkey.slice(0, 8);

    transport.onMessage(function (frame) {
      // handleFrame is async (NIP-04 decrypt); never leak a rejection into
      // the transport — decrypt failures are handled inside.
      handleFrame(frame).catch(function () {});
    });

    /** Subscribe to responses addressed to us on every relay (idempotent). */
    function start() {
      if (started || closed) return;
      started = true;
      var filter = { kinds: [NIP46_KIND], "#p": [clientPubkey] };
      for (var i = 0; i < relays.length; i++) {
        transport.send(relays[i], ["REQ", subId, filter]);
      }
    }

    /**
     * Encrypt (NIP-44, or NIP-04 in legacy mode), wrap in a signed kind-24133
     * event, publish everywhere. `useNip04` overrides the session mode for a
     * single publish (the one-shot connect retry) WITHOUT downgrading the
     * whole session.
     */
    async function publish(id, method, params, useNip04) {
      var viaNip04 = useNip04 === undefined ? legacyNip04 : useNip04 === true;
      var content;
      if (viaNip04) {
        content = await C.nip04Encrypt(
          clientSk,
          remotePk,
          JSON.stringify({ id: id, method: method, params: params }),
        );
      } else {
        content = encodeRequest(convKey, { id: id, method: method, params: params });
      }
      var ev = C.finalizeEvent(
        {
          kind: NIP46_KIND,
          created_at: nowSec(),
          tags: [["p", remotePk]],
          content: content,
        },
        clientSk,
      );
      for (var i = 0; i < relays.length; i++) {
        transport.send(relays[i], ["EVENT", ev]);
      }
    }

    /** Queue a request: random id, publish, resolve/reject by response id, 60s timeout. */
    function request(method, params) {
      if (closed) return Promise.reject(new Error("nip46: client closed"));
      start();
      return new Promise(function (resolve, reject) {
        // Unguessable id: a malicious relay must not be able to predict the
        // id of a future request and replay a recorded response under it.
        var id = C.bytesToHex(C.randomBytes(8));
        var entry = {
          resolve: resolve,
          reject: reject,
          method: method,
          params: params,
          retriedNip04: false,
          timer: null,
        };
        entry.timer = setTimeoutFn(function () {
          if (pending.get(id) === entry) {
            pending.delete(id);
            reject(
              new Error("nip46: " + method + " timed out after " + timeoutMs / 1000 + "s"),
            );
          }
        }, timeoutMs);
        pending.set(id, entry);
        publish(id, method, params).catch(function (err) {
          if (pending.get(id) === entry) {
            pending.delete(id);
            clearTimeoutFn(entry.timer);
            reject(err);
          }
        });
      });
    }

    /**
     * The signer could not decrypt our NIP-44 request (it never even sends a
     * matching response id in that case — some signers send an undecryptable
     * error blob instead). Re-send the pending connect NIP-04-encrypted
     * exactly once. IMPORTANT: this does NOT flip the session into legacy
     * mode — only a successfully DECRYPTED NIP-04 response does that
     * (handleFrame), so a relay-injected garbage event can never downgrade
     * the session's encryption.
     */
    function retryConnectWithNip04() {
      if (legacyNip04) return;
      var iterator = pending.entries();
      for (var step = iterator.next(); !step.done; step = iterator.next()) {
        var id = step.value[0];
        var entry = step.value[1];
        if (entry.method !== "connect" || entry.retriedNip04) continue;
        entry.retriedNip04 = true;
        (function (retryId, retryEntry) {
          publish(retryId, retryEntry.method, retryEntry.params, true).catch(function (err) {
            if (pending.get(retryId) === retryEntry) {
              pending.delete(retryId);
              clearTimeoutFn(retryEntry.timer);
              retryEntry.reject(err);
            }
          });
        })(id, entry);
        return;
      }
    }

    async function handleFrame(frame) {
      if (closed || !Array.isArray(frame) || frame[0] !== "EVENT") return;
      var ev = frame[2];
      if (!ev || ev.kind !== NIP46_KIND || typeof ev.content !== "string") return;
      // Only the paired remote signer matters. Anyone else publishing to our
      // "#p" subscription lacks the conversation key anyway — decryption
      // below would fail — but reject early and cheaply.
      if (ev.pubkey !== remotePk) return;
      // AUTHENTICATE the envelope before reacting to it in any way: ev.pubkey
      // alone is attacker-controlled, so a forged event must not be able to
      // reach the decrypt-failure path (which triggers the NIP-04 connect
      // retry) — only events genuinely signed by the remote signer may.
      if (!verifyEnvelope(ev)) return;
      var msg;
      try {
        msg = await decodeResponse(convKey, ev.content, {
          skBytes: clientSk,
          peerPubkey: remotePk,
        });
      } catch (_err) {
        retryConnectWithNip04();
        return;
      }
      // A successfully decrypted NIP-04 response means a legacy signer:
      // switch our request encryption over so the rest of the session speaks
      // its dialect. A NIP-44 response proves the signer speaks the modern
      // dialect — undo any earlier downgrade.
      legacyNip04 = ev.content.indexOf("?iv=") !== -1;
      if (msg.id === null || msg.id === undefined) return;
      var id = String(msg.id);
      var entry = pending.get(id);
      if (!entry) return; // duplicate or unknown response id — ignore
      if (msg.result === "auth_url") {
        // The signer wants explicit user approval in a browser. Surface the
        // URL (never auto-navigate) and keep the request pending with a
        // fresh timeout so the user has time to approve.
        clearTimeoutFn(entry.timer);
        entry.timer = setTimeoutFn(function () {
          if (pending.get(id) === entry) {
            pending.delete(id);
            entry.reject(
              new Error("nip46: " + entry.method + " timed out awaiting auth approval"),
            );
          }
        }, timeoutMs);
        if (onAuthUrl) {
          try {
            onAuthUrl(String(msg.error || ""), id);
          } catch (_e) {
            /* callback errors must not poison the state machine */
          }
        }
        return;
      }
      pending.delete(id);
      clearTimeoutFn(entry.timer);
      if (msg.error) {
        var err = new Error("nip46: " + entry.method + " failed: " + String(msg.error));
        err.nip46Error = String(msg.error);
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
    }

    /** NIP-46 connect handshake. Resolves with "ack" (or the echoed secret). */
    function connect(remoteSignerPubkeyArg, secretArg) {
      var pk = remoteSignerPubkeyArg
        ? String(remoteSignerPubkeyArg).toLowerCase()
        : remotePk;
      if (pk !== remotePk) {
        return Promise.reject(
          new Error("nip46: connect pubkey differs from the client's remote signer"),
        );
      }
      var secret = typeof secretArg === "string" ? secretArg : defaultSecret;
      return request("connect", secret ? [remotePk, secret] : [remotePk]);
    }

    /** The USER pubkey held by the remote signer (not the signer's own key). */
    async function get_public_key() {
      var result = await request("get_public_key", []);
      if (typeof result !== "string" || !HEX64.test(result.toLowerCase())) {
        throw new Error("nip46: get_public_key returned a malformed pubkey");
      }
      return result.toLowerCase();
    }

    /** Recompute the NIP-01 id and schnorr-verify; throw on any mismatch. */
    function verifySignedEvent(signed) {
      if (!signed || typeof signed !== "object") {
        throw new Error("nip46: signer returned no event");
      }
      if (
        typeof signed.id !== "string" ||
        typeof signed.pubkey !== "string" ||
        typeof signed.sig !== "string" ||
        typeof signed.kind !== "number" ||
        typeof signed.created_at !== "number" ||
        !Array.isArray(signed.tags) ||
        typeof signed.content !== "string"
      ) {
        throw new Error("nip46: signer returned a malformed event");
      }
      var expectedId = C.eventId({
        pubkey: signed.pubkey,
        created_at: signed.created_at,
        kind: signed.kind,
        tags: signed.tags,
        content: signed.content,
      });
      if (expectedId !== signed.id) {
        throw new Error("nip46: signed event id mismatch");
      }
      if (!C.schnorrVerify(signed.sig, signed.id, signed.pubkey)) {
        throw new Error("nip46: signed event signature is invalid");
      }
    }

    /**
     * The signed event must be THE event we asked to sign, not merely any
     * validly-signed event — otherwise a compromised signer (or a replayed
     * response) could substitute an old event of a different kind/content.
     * Fields the caller left for the signer to fill (created_at, tags,
     * pubkey) are only compared when the request pinned them.
     */
    function assertMatchesRequest(signed, unsigned) {
      var ok =
        signed.kind === unsigned.kind &&
        signed.content === unsigned.content &&
        (typeof unsigned.created_at !== "number" ||
          signed.created_at === unsigned.created_at) &&
        (!Array.isArray(unsigned.tags) ||
          JSON.stringify(signed.tags) === JSON.stringify(unsigned.tags)) &&
        (typeof unsigned.pubkey !== "string" ||
          signed.pubkey === unsigned.pubkey.toLowerCase());
      if (!ok) {
        throw new Error(
          "nip46: signer returned an event that does not match the signing request",
        );
      }
    }

    /**
     * Ask the remote signer to sign an unsigned event (JSON string in,
     * JSON string out). SECURITY: the response is verified cryptographically
     * (id recomputed + schnorr sig checked) AND compared field-by-field
     * against the submitted unsigned event before being returned — the
     * response shape is never trusted.
     */
    async function sign_event(unsignedJson) {
      if (typeof unsignedJson !== "string") {
        throw new Error("nip46: sign_event expects the unsigned event as a JSON string");
      }
      var unsigned;
      try {
        unsigned = JSON.parse(unsignedJson);
      } catch (_e) {
        unsigned = null;
      }
      if (!unsigned || typeof unsigned !== "object" || Array.isArray(unsigned)) {
        throw new Error("nip46: sign_event expects a JSON object event");
      }
      var result = await request("sign_event", [unsignedJson]);
      var signed;
      try {
        signed = typeof result === "string" ? JSON.parse(result) : result;
      } catch (_e) {
        throw new Error("nip46: sign_event returned unparseable JSON");
      }
      verifySignedEvent(signed);
      assertMatchesRequest(signed, unsigned);
      return JSON.stringify(signed);
    }

    /** Close the subscription and transport; reject anything still pending. */
    function close() {
      if (closed) return;
      closed = true;
      pending.forEach(function (entry) {
        clearTimeoutFn(entry.timer);
        entry.reject(new Error("nip46: client closed"));
      });
      pending.clear();
      if (started) {
        for (var i = 0; i < relays.length; i++) {
          try {
            transport.send(relays[i], ["CLOSE", subId]);
          } catch (_e) {
            /* transport already gone */
          }
        }
      }
      try {
        transport.close();
      } catch (_e) {
        /* already closed */
      }
    }

    return {
      clientPubkey: clientPubkey,
      start: start,
      close: close,
      connect: connect,
      get_public_key: get_public_key,
      sign_event: sign_event,
      isLegacyNip04: function () {
        return legacyNip04;
      },
    };
  }

  // -------------------------------------------------------------------------
  // Real WebSocket transport adapter (browser only — kept OUT of createClient)
  // -------------------------------------------------------------------------

  /**
   * Open one WebSocket per relay. Frames are JSON arrays; sends before the
   * socket opens are queued and flushed on open. CSP note: connect-src
   * allows wss:, so remote-signer relays work without any policy change.
   */
  function openRealTransport(relayUrls) {
    var handler = null;
    var entries = [];
    for (var i = 0; i < relayUrls.length; i++) {
      (function (url) {
        var entry = { url: url, ws: null, queue: [] };
        entries.push(entry);
        var ws;
        try {
          ws = new WebSocket(url);
        } catch (_e) {
          return; // bad URL / blocked — other relays may still work
        }
        entry.ws = ws;
        ws.onopen = function () {
          var queued = entry.queue;
          entry.queue = [];
          for (var j = 0; j < queued.length; j++) {
            try {
              ws.send(queued[j]);
            } catch (_e) {
              /* socket died between open and send */
            }
          }
        };
        ws.onmessage = function (m) {
          if (!handler || typeof m.data !== "string") return;
          var frame;
          try {
            frame = JSON.parse(m.data);
          } catch (_e) {
            return;
          }
          try {
            handler(frame);
          } catch (_e) {
            /* handler errors must not kill the socket */
          }
        };
      })(relayUrls[i]);
    }
    return {
      send: function (relayUrl, frame) {
        var text = JSON.stringify(frame);
        for (var k = 0; k < entries.length; k++) {
          var e = entries[k];
          if (e.url !== relayUrl || !e.ws) continue;
          if (e.ws.readyState === 1) {
            try {
              e.ws.send(text);
            } catch (_e) {
              /* closing */
            }
          } else if (e.ws.readyState === 0) {
            e.queue.push(text);
          }
        }
      },
      onMessage: function (cb) {
        handler = cb;
      },
      close: function () {
        handler = null;
        for (var k = 0; k < entries.length; k++) {
          if (entries[k].ws) {
            try {
              entries[k].ws.close();
            } catch (_e) {
              /* already closed */
            }
          }
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // Persistence ("nbread:signer:nip46") — guarded, import-safe in workerd
  // -------------------------------------------------------------------------

  function getStorage() {
    try {
      var ls = globalThis.localStorage;
      return ls || null;
    } catch (_e) {
      return null; // privacy mode / sandbox where the getter itself throws
    }
  }

  /** Load + validate the stored pairing; null when absent or malformed. */
  function loadState() {
    var ls = getStorage();
    if (!ls) return null;
    var raw;
    try {
      raw = ls.getItem(STORAGE_KEY);
    } catch (_e) {
      return null;
    }
    if (!raw) return null;
    var s;
    try {
      s = JSON.parse(raw);
    } catch (_e) {
      return null;
    }
    if (!s || typeof s !== "object") return null;
    if (typeof s.clientSkHex !== "string" || !HEX64.test(s.clientSkHex)) return null;
    if (typeof s.remoteSignerPubkey !== "string" || !HEX64.test(s.remoteSignerPubkey)) return null;
    if (typeof s.userPubkey !== "string" || !HEX64.test(s.userPubkey)) return null;
    if (!Array.isArray(s.relays) || !s.relays.length) return null;
    return s;
  }

  /** Persist a completed pairing and make nip46 the active signer method. */
  function persistPairing(p) {
    var state = {
      clientSkHex: p.clientSkHex,
      remoteSignerPubkey: p.remoteSignerPubkey,
      userPubkey: p.userPubkey,
      relays: p.relays,
      pairedAt: Math.floor(Date.now() / 1000),
    };
    if (typeof p.secret === "string" && p.secret) state.secret = p.secret;
    if (p.legacyNip04) state.legacyNip04 = true;
    var ls = getStorage();
    if (!ls) throw new Error("nip46: localStorage is unavailable");
    ls.setItem(STORAGE_KEY, JSON.stringify(state));
    // The signer registry owns "which method is active"; fall back to the
    // shared storage key when its API is absent.
    var S = globalThis.NbreadSigner;
    if (S && typeof S.setMethod === "function") {
      S.setMethod("nip46");
    } else {
      try {
        ls.setItem(METHOD_KEY, "nip46");
      } catch (_e) {
        /* quota — pairing itself still persisted above */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pairing flows (configure)
  // -------------------------------------------------------------------------

  /** Signer-initiated pairing: user pasted a bunker:// URI from their signer. */
  async function configureBunker(uri, opts) {
    var parsed = parseBunkerUri(uri);
    var clientSkHex = C.bytesToHex(C.randomBytes(32));
    var transport = opts.transport || openRealTransport(parsed.relays);
    var client = createClient({
      transport: transport,
      clientSkHex: clientSkHex,
      remoteSignerPubkey: parsed.remoteSignerPubkey,
      relays: parsed.relays,
      secret: parsed.secret,
      onAuthUrl: opts.onAuthUrl,
      timeoutSec: opts.timeoutSec,
    });
    try {
      await client.connect(parsed.remoteSignerPubkey, parsed.secret);
      var userPubkey = await client.get_public_key();
      persistPairing({
        clientSkHex: clientSkHex,
        remoteSignerPubkey: parsed.remoteSignerPubkey,
        userPubkey: userPubkey,
        relays: parsed.relays,
        secret: parsed.secret,
        legacyNip04: client.isLegacyNip04(),
      });
      return { userPubkey: userPubkey };
    } finally {
      client.close();
    }
  }

  /**
   * Wait for the remote signer's connect response after the user pasted our
   * nostrconnect:// URI into it. SECURITY: only a response carrying the
   * exact pairing secret is accepted — a bare "ack" could be forged by
   * anyone watching the relay, and whoever we accept here becomes the
   * trusted signer for every future sign_event.
   */
  function waitForNostrconnectAck(transport, relays, clientSk, clientPubkey, secret, timeoutSec) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error("nip46: nostrconnect pairing timed out — the signer never responded"));
      }, timeoutSec * 1000);
      transport.onMessage(function (frame) {
        if (done || !Array.isArray(frame) || frame[0] !== "EVENT") return;
        var ev = frame[2];
        if (!ev || ev.kind !== NIP46_KIND || typeof ev.content !== "string") return;
        if (typeof ev.pubkey !== "string" || !HEX64.test(ev.pubkey)) return;
        // Whoever we accept here becomes the trusted signer — require a
        // genuinely signed envelope, not just a self-declared pubkey field.
        if (!verifyEnvelope(ev)) return;
        var convKey;
        try {
          convKey = C.nip44ConversationKey(clientSk, ev.pubkey);
        } catch (_e) {
          return;
        }
        decodeResponse(convKey, ev.content, { skBytes: clientSk, peerPubkey: ev.pubkey })
          .then(function (msg) {
            if (done || msg.result !== secret) return;
            done = true;
            clearTimeout(timer);
            resolve(ev.pubkey);
          })
          .catch(function () {
            /* not decryptable by us — not our pairing response */
          });
      });
      for (var i = 0; i < relays.length; i++) {
        transport.send(relays[i], [
          "REQ",
          "nbread46-pair",
          { kinds: [NIP46_KIND], "#p": [clientPubkey] },
        ]);
      }
    });
  }

  /** Client-initiated pairing: we mint the nostrconnect:// URI, the user pastes it into the signer. */
  async function configureNostrconnect(input, opts) {
    var cfg = input && typeof input === "object" ? input : {};
    var relays = cfg.relays || opts.relays;
    if (!Array.isArray(relays) || !relays.length) {
      throw new Error('nip46: nostrconnect pairing needs {relays: ["wss://…"]}');
    }
    assertWssRelays(relays);
    var clientSkHex = C.bytesToHex(C.randomBytes(32));
    var clientSk = C.hexToBytes(clientSkHex);
    var clientPubkey = C.getPublicKeyHex(clientSk);
    var secret = C.bytesToHex(C.randomBytes(16));
    var uri = buildNostrconnectUri({
      clientPubkey: clientPubkey,
      relays: relays,
      secret: secret,
      name: cfg.name || opts.name || "nbread",
    });
    var onUri = cfg.onUri || opts.onUri;
    if (typeof onUri === "function") onUri(uri);
    var transport = cfg.transport || opts.transport || openRealTransport(relays);
    var timeoutSec = cfg.timeoutSec || opts.timeoutSec || DEFAULT_PAIRING_TIMEOUT_SEC;
    var remoteSignerPubkey;
    try {
      remoteSignerPubkey = await waitForNostrconnectAck(
        transport,
        relays,
        clientSk,
        clientPubkey,
        secret,
        timeoutSec,
      );
    } catch (err) {
      try {
        transport.close();
      } catch (_e) {
        /* already closed */
      }
      throw err;
    }
    // createClient re-binds transport.onMessage to its own handler, ending
    // the pairing listener above.
    var client = createClient({
      transport: transport,
      clientSkHex: clientSkHex,
      remoteSignerPubkey: remoteSignerPubkey,
      relays: relays,
      secret: secret,
      onAuthUrl: cfg.onAuthUrl || opts.onAuthUrl,
      timeoutSec: cfg.timeoutSec || opts.timeoutSec,
    });
    try {
      var userPubkey = await client.get_public_key();
      persistPairing({
        clientSkHex: clientSkHex,
        remoteSignerPubkey: remoteSignerPubkey,
        userPubkey: userPubkey,
        relays: relays,
        secret: secret,
        legacyNip04: client.isLegacyNip04(),
      });
      return { userPubkey: userPubkey };
    } finally {
      client.close();
    }
  }

  // -------------------------------------------------------------------------
  // The registered backend
  // -------------------------------------------------------------------------

  var backend = {
    /** Usable now? {ok:true} iff a validated pairing is stored. */
    ready: function () {
      if (!getStorage()) {
        return { ok: false, reason: "localStorage is unavailable" };
      }
      if (!loadState()) {
        return {
          ok: false,
          reason: "no NIP-46 pairing stored — connect a remote signer (bunker:// or nostrconnect) first",
        };
      }
      return { ok: true };
    },

    /** The user pubkey learned at pairing time (no network round-trip). */
    getPublicKey: function () {
      var s = loadState();
      if (!s) throw new Error("nip46: not configured — pair a remote signer first");
      return s.userPubkey;
    },

    /**
     * Sign one unsigned event via the paired remote signer over real
     * WebSockets. Returns the verified signed event object. An
     * "unauthorized" error from the signer is surfaced as a
     * reconnect-needed error (err.code === "nip46-reconnect-needed").
     */
    signEvent: async function (unsigned) {
      var s = loadState();
      if (!s) throw new Error("nip46: not configured — pair a remote signer first");
      var transport = openRealTransport(s.relays);
      var client = createClient({
        transport: transport,
        clientSkHex: s.clientSkHex,
        remoteSignerPubkey: s.remoteSignerPubkey,
        relays: s.relays,
        secret: s.secret,
        legacyNip04: s.legacyNip04 === true,
      });
      try {
        var signedJson = await client.sign_event(JSON.stringify(unsigned));
        var signed = JSON.parse(signedJson);
        // The event is already cryptographically verified by sign_event;
        // additionally pin it to the paired identity so a signer swap
        // cannot silently publish as someone else.
        if (signed.pubkey !== s.userPubkey) {
          throw new Error("nip46: signer returned an event for a different pubkey");
        }
        return signed;
      } catch (err) {
        var detail = String((err && (err.nip46Error || err.message)) || "");
        if (/unauthorized/i.test(detail)) {
          var e = new Error(
            "nip46: the remote signer no longer authorizes this session — reconnect your signer",
          );
          e.code = "nip46-reconnect-needed";
          throw e;
        }
        throw err;
      } finally {
        client.close();
      }
    },

    /**
     * Pair with a remote signer and persist the session.
     *   configure("bunker://…")                — signer-initiated pairing
     *   configure({relays, name?, onUri})      — client-initiated
     *     (nostrconnect): mints the URI, hands it to onUri for the user to
     *     copy into their signer, then waits for the secret-bearing ack.
     * opts (second arg, optional): {onAuthUrl, timeoutSec, transport (tests)}.
     * Resolves {userPubkey}.
     */
    configure: async function (input, opts) {
      opts = opts || {};
      if (!getStorage()) throw new Error("nip46: localStorage is unavailable");
      if (typeof input === "string" && /^bunker:\/\//i.test(input)) {
        return configureBunker(input, opts);
      }
      return configureNostrconnect(input, opts);
    },
  };

  // -------------------------------------------------------------------------
  // Export + registry side effect
  // -------------------------------------------------------------------------

  var api = {
    parseBunkerUri: parseBunkerUri,
    buildNostrconnectUri: buildNostrconnectUri,
    encodeRequest: encodeRequest,
    decodeResponse: decodeResponse,
    createClient: createClient,
    openRealTransport: openRealTransport,
    backend: backend,
  };
  Object.freeze(api);
  globalThis.NbreadNip46 = api;

  if (
    globalThis.NbreadSigner &&
    typeof globalThis.NbreadSigner.register === "function"
  ) {
    globalThis.NbreadSigner.register("nip46", backend);
  }
})();
