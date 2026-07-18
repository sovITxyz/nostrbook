// NbreadBlossom — direct-from-browser image uploads to Blossom media servers
// (Nostr blob storage, BUD-01/02/04). The editor toolbar (editor-toolbar.js)
// calls uploadBlob() when the user drops, pastes, or picks an image; the file
// bytes go straight to the server over an authenticated PUT and never touch
// our Worker.
//
// Flow: hash the blob (SHA-256) -> sign a kind-24242 "Upload Blob" auth event
// with NbreadSigner -> PUT the raw bytes to the PRIMARY server's /upload ->
// validate the returned descriptor (https URL + sha match) -> best-effort
// mirror the URL (BUD-04, no re-upload) to the remaining servers. On a
// any per-server failure the next server is promoted to primary, so the
// whole mirror set is tried before an upload is reported as failed.
//
// Load order (classic <script> includes, no modules):
//   vendor/nostr-crypto.js -> signer stack -> blossom.js -> editor-toolbar.js
//
// SECURITY: a hostile server could answer with a javascript:/data:/relative
// URL; every descriptor URL is validated as an absolute https:// URL before
// it can reach the editor, and its sha256 is checked against the bytes we
// hashed so a swapped blob is rejected.
//
// Pure helpers (buildAuthEvent/encodeAuthHeader/validateFile/isHttpsUrl/
// extForType/BLOSSOM_SERVERS) touch no network or DOM and are unit-tested;
// uploadBlob() is the network entry point.
(function () {
  "use strict";

  // PRIMARY leads; the rest are redundancy mirrors. All four are public,
  // CORS-open, and accept anonymous signed uploads.
  var BLOSSOM_SERVERS = [
    "https://blossom.band", // primary — indefinite retention, most battle-tested
    "https://blossom.nostr.build",
    "https://nostr.download",
    "https://cdn.nostrcheck.me",
  ];

  var DEFAULT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  var DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20 MiB
  var AUTH_TTL_SEC = 300; // expiration window on the signed auth event
  var REQUEST_TIMEOUT_MS = 30000;

  function cryptoApi() {
    return globalThis.NbreadCrypto;
  }
  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  // --- Pure helpers -------------------------------------------------------------

  // The unsigned BUD-02 auth template. created_at MUST be now (seconds) and
  // MUST NOT be in the future; the "x" tag is the lowercase-hex SHA-256 of the
  // exact blob bytes, and the event expires AUTH_TTL_SEC later.
  function buildAuthEvent(shaHex, sec) {
    return {
      kind: 24242,
      created_at: sec,
      content: "Upload Blob",
      tags: [
        ["t", "upload"],
        ["x", shaHex],
        ["expiration", String(sec + AUTH_TTL_SEC)],
      ],
    };
  }

  // base64url with NO padding: btoa-equivalent, then +/ -> -_, strip '='.
  function base64Url(bytes) {
    return cryptoApi()
      .base64Encode(bytes)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  // "Nostr <base64url(JSON.stringify(signedEvent))>" — exactly one space.
  function encodeAuthHeader(signedEvent) {
    var bytes = cryptoApi().utf8Encode(JSON.stringify(signedEvent));
    return "Nostr " + base64Url(bytes);
  }

  // Duck-typed so it works on real File objects and plain {type,size} stubs.
  function validateFile(file, opts) {
    opts = opts || {};
    var types = opts.types || DEFAULT_TYPES;
    var maxBytes =
      typeof opts.maxBytes === "number" ? opts.maxBytes : DEFAULT_MAX_BYTES;
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.size !== "number" ||
      typeof file.type !== "string"
    ) {
      return { ok: false, reason: "That is not a file." };
    }
    if (types.indexOf(file.type) === -1) {
      return {
        ok: false,
        reason: "Unsupported image type (" + (file.type || "unknown") + ").",
      };
    }
    if (file.size <= 0) {
      return { ok: false, reason: "That image is empty." };
    }
    if (file.size > maxBytes) {
      return {
        ok: false,
        reason:
          "Image is too large (max " +
          Math.round(maxBytes / (1024 * 1024)) +
          " MB).",
      };
    }
    return { ok: true };
  }

  // Absolute https:// URL only. Rejects http/javascript/data/relative/empty
  // (new URL() with no base throws on a relative string).
  //
  // Protocol alone is NOT enough: new URL() happily parses
  // "https://evil/x.png) [phish](https://evil)" or "...x.png\n\n# Injected"
  // as protocol "https:", and that raw string is later spliced into a
  // "![](<url>)" markdown image — the first ')' / newline terminates the
  // destination and everything after it renders as live attacker markdown.
  // So we also reject any char that can break out of the markdown
  // destination: whitespace/control chars and ()<>"'` (backtick). A genuine
  // Blossom URL (https://host/<sha256>.<ext>) never contains these.
  function isHttpsUrl(u) {
    if (typeof u !== "string" || u === "") return false;
    if (/[\s()<>"'`]/.test(u)) return false;
    var parsed;
    try {
      parsed = new URL(u);
    } catch (_) {
      return false;
    }
    return parsed.protocol === "https:";
  }

  function extForType(mime) {
    switch (mime) {
      case "image/png":
        return "png";
      case "image/jpeg":
        return "jpg";
      case "image/webp":
        return "webp";
      case "image/gif":
        return "gif";
      default:
        return "bin";
    }
  }

  // --- Network ------------------------------------------------------------------

  function sha256Hex(arrayBuffer) {
    return crypto.subtle.digest("SHA-256", arrayBuffer).then(function (digest) {
      return cryptoApi().bytesToHex(new Uint8Array(digest));
    });
  }

  // A single PUT with a ~30s abort timeout. Resolves to the parsed descriptor
  // on 200/201; throws with .status set on any other HTTP status; network
  // errors / aborts throw without a .status (treated as "advance to next").
  function putBlob(server, file, authHeader) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    return fetch(server + "/upload", {
      method: "PUT",
      body: file,
      headers: {
        Authorization: authHeader,
        "Content-Type": file.type || "application/octet-stream",
      },
      signal: controller.signal,
    })
      .then(function (res) {
        clearTimeout(timer);
        if (res.status !== 200 && res.status !== 201) {
          var err = new Error("Upload failed (HTTP " + res.status + ").");
          err.status = res.status;
          throw err;
        }
        return res.json();
      })
      .catch(function (e) {
        clearTimeout(timer);
        throw e;
      });
  }

  // BUD-04 mirror: hand the successful upload's URL to another server so it
  // fetches the blob itself. Reuses the SAME auth header (still fresh — the
  // 24242 event covers this blob's hash and hasn't expired), so no extra
  // signer prompt. Best-effort: every failure is swallowed.
  function mirrorTo(server, url, authHeader) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    return fetch(server + "/mirror", {
      method: "PUT",
      body: JSON.stringify({ url: url }),
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    })
      .then(function () {
        clearTimeout(timer);
      })
      .catch(function () {
        clearTimeout(timer);
      });
  }

  // Upload a File/Blob and return { url, sha256 } (the final markdown image
  // URL + the verified content hash). Throws a user-facing Error on failure.
  function uploadBlob(file, opts) {
    opts = opts || {};
    var signer = opts.signer;
    var servers = opts.servers || BLOSSOM_SERVERS;

    var check = validateFile(file, {
      maxBytes: opts.maxBytes,
      types: opts.types,
    });
    if (!check.ok) return Promise.reject(new Error(check.reason));

    if (!signer || typeof signer.signEvent !== "function") {
      return Promise.reject(
        new Error("No signer configured — image upload needs a signing key."),
      );
    }
    if (
      typeof signer.isRedirectSigner === "function" &&
      signer.isRedirectSigner()
    ) {
      return Promise.reject(
        new Error(
          "Image upload isn't supported with this signer (Amber redirect); paste an image URL instead.",
        ),
      );
    }

    return Promise.resolve(file.arrayBuffer())
      .then(function (buf) {
        return sha256Hex(buf).then(function (shaHex) {
          return uploadToServers(file, shaHex, signer, servers);
        });
      });
  }

  // Try each server in turn as primary. On success, fire the mirrors and
  // resolve; a 4xx (auth/permission, not 429) surfaces immediately.
  function uploadToServers(file, shaHex, signer, servers) {
    var lastErr = null;

    function attempt(i) {
      if (i >= servers.length) {
        return Promise.reject(
          lastErr || new Error("Image upload failed on every server."),
        );
      }
      var server = servers[i];
      // Re-sign per server: the auth is bound to created_at freshness, and a
      // fresh signature per attempt sidesteps any clock skew on retries.
      var unsigned = buildAuthEvent(shaHex, nowSec());
      return Promise.resolve(signer.signEvent(unsigned)).then(function (signed) {
        var header = encodeAuthHeader(signed);
        return putBlob(server, file, header).then(
          function (descriptor) {
            if (!descriptor || !isHttpsUrl(descriptor.url)) {
              lastErr = new Error("Server returned an unusable image URL.");
              return attempt(i + 1);
            }
            if (
              typeof descriptor.sha256 === "string" &&
              descriptor.sha256.toLowerCase() !== shaHex
            ) {
              lastErr = new Error("Uploaded image failed its integrity check.");
              return attempt(i + 1);
            }
            // Mirror to the rest, best-effort, without blocking the return.
            for (var m = 0; m < servers.length; m++) {
              if (servers[m] !== server) {
                mirrorTo(servers[m], descriptor.url, header);
              }
            }
            return { url: descriptor.url, sha256: shaHex };
          },
          function (err) {
            lastErr = err;
            // Advance to the next server on ANY failure. Different public
            // Blossom servers have different upload policies, rate limits,
            // and transient errors (a 4xx from one — throttle, whitelist,
            // size/type quirk — or a 5xx/network blip must not abort the
            // others), so we exhaust the whole mirror set before giving up.
            // Only when every server has failed does attempt() reject with
            // the last error. Client-side validateFile already caps size and
            // type, so this can't loop on an oversized/unsupported blob.
            return attempt(i + 1);
          },
        );
      });
    }

    return attempt(0);
  }

  var api = {
    BLOSSOM_SERVERS: BLOSSOM_SERVERS,
    buildAuthEvent: buildAuthEvent,
    encodeAuthHeader: encodeAuthHeader,
    validateFile: validateFile,
    isHttpsUrl: isHttpsUrl,
    extForType: extForType,
    uploadBlob: uploadBlob,
  };

  Object.freeze(api);
  globalThis.NbreadBlossom = api;
})();
