// Profile glue: build the user's kind 0 metadata event from the dashboard
// profile form, sign it through the NbreadSigner abstraction (NIP-07
// extension, NIP-46 remote bunker, NIP-55/Amber redirect, or a stored local
// key), broadcast it to the user's relays client-side (best-effort, with
// NIP-42 AUTH support), and POST the signed event to /api/mirror so the
// stored profile updates immediately. Field values the form does not edit
// (cfg.extra — custom keys other clients published) are merged back into the
// content so a save never erases them. No secret key ever enters this file.
// NIP-55 signing round-trips through a full page redirect — the resume block
// below picks the flow back up when Amber sends the user back.
(function () {
  "use strict";

  var cfgEl = document.getElementById("profile-config");
  var form = document.getElementById("profile-form");
  if (!cfgEl || !form) return;

  var cfg;
  try {
    cfg = JSON.parse(cfgEl.textContent || "{}");
  } catch (e) {
    return;
  }

  // Form field ids, keyed by the kind 0 content key they edit.
  var FIELD_IDS = {
    name: "profile-name",
    display_name: "profile-display-name",
    about: "profile-about",
    picture: "profile-picture",
    banner: "profile-banner",
    website: "profile-website",
    nip05: "profile-nip05",
    lud16: "profile-lud16",
    lud06: "profile-lud06",
  };

  var statusEl = document.getElementById("profile-status");
  var publishBtn = document.getElementById("profile-publish");

  function say(message) {
    if (statusEl) statusEl.textContent = message;
  }

  // A signer must be configured AND belong to the identity this dashboard
  // session is signed in as (same guard as editor.js — see the NIP-55 note
  // there: ready() only reports ok with a stored pubkey, so getPublicKey()
  // never redirects from here).
  async function ensureSigner() {
    var r;
    try {
      r = await NbreadSigner.ready();
    } catch (e) {
      r = { ok: false };
    }
    if (!r || !r.ok) {
      say(
        "No signer configured in this browser — open " +
          location.origin +
          "/login, choose a signing method, then come back and retry.",
      );
      return false;
    }
    var pk;
    try {
      pk = await NbreadSigner.getPublicKey();
    } catch (e) {
      say(String((e && e.message) || e));
      return false;
    }
    if (pk !== cfg.pubkey) {
      say(
        "This browser's signer is a different Nostr identity than the one signed in. Sign out and back in, or switch signer on the login page.",
      );
      return false;
    }
    return true;
  }

  function nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  // An edit must WIN the replaceable (pubkey, 0, '') slot: created_at
  // strictly greater than the stored version's (ties break on id and can
  // lose).
  function nextCreatedAt() {
    var prev = typeof cfg.prevCreatedAt === "number" ? cfg.prevCreatedAt : 0;
    return Math.max(nowSeconds(), prev + 1);
  }

  // Metadata object for the kind 0 content: the preserved non-form keys
  // first, then every non-empty form field on top. A field the user cleared
  // is simply absent (kind 0 is a full replacement, absence deletes it).
  function buildMetadata() {
    var out = {};
    var extra = cfg.extra;
    if (extra !== null && typeof extra === "object" && !Array.isArray(extra)) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
      }
    }
    for (var key in FIELD_IDS) {
      if (!Object.prototype.hasOwnProperty.call(FIELD_IDS, key)) continue;
      var el = document.getElementById(FIELD_IDS[key]);
      var value = el && el.value ? el.value : "";
      value = value.replace(/\r\n?/g, "\n").trim();
      if (value !== "") out[key] = value;
    }
    return out;
  }

  // Best-effort broadcast with NIP-42 AUTH — same contract as editor.js
  // (resolves once every relay attempt finishes, never rejects; redirect
  // signers skip AUTH because signing would navigate away mid-broadcast).
  function broadcast(event) {
    var relays = Array.isArray(cfg.relays) ? cfg.relays : [];
    var message = JSON.stringify(["EVENT", event]);
    var attempts = relays.map(function (url) {
      return new Promise(function (resolve) {
        var ws = null;
        var done = false;
        var timer = null;
        var startedAt = Date.now();
        var authTried = false; // at most one AUTH round per connection
        var authEventId = null; // our kind-22242 id, to match its OK frame
        var eventResent = false; // EVENT resent after an accepted AUTH
        function finish() {
          if (done) return;
          done = true;
          if (timer !== null) clearTimeout(timer);
          try {
            if (ws) ws.close();
          } catch (e) {
            /* already closed */
          }
          resolve();
        }
        // (Re)arm the deadline as "totalMs after the connection started",
        // so an AUTH extension is a total budget, not a fresh window.
        function deadline(totalMs) {
          if (done) return;
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(finish, Math.max(0, startedAt + totalMs - Date.now()));
        }
        function sendEvent() {
          try {
            ws.send(message);
          } catch (e) {
            finish();
          }
        }
        function handleAuthChallenge(challenge) {
          if (NbreadSigner.isRedirectSigner()) return;
          deadline(8000); // signing + the extra round-trip needs headroom
          var unsignedAuth = {
            kind: 22242,
            created_at: nowSeconds(),
            tags: [
              ["relay", url],
              ["challenge", challenge],
            ],
            content: "",
          };
          NbreadSigner.signEvent(unsignedAuth).then(
            function (signedAuth) {
              if (done) return;
              if (!signedAuth || typeof signedAuth.id !== "string") return;
              authEventId = signedAuth.id;
              try {
                ws.send(JSON.stringify(["AUTH", signedAuth]));
              } catch (e) {
                finish();
              }
            },
            function () {
              /* signing declined/failed — just wait out the deadline */
            },
          );
        }
        function handleFrame(frame) {
          if (!Array.isArray(frame)) return;
          if (frame[0] === "OK") {
            if (frame[1] === event.id) {
              // NIP-42 pre-auth rejection (see editor.js): an OK false
              // "auth-required:" must not end the attempt while our AUTH
              // round can still complete and resend the EVENT.
              var authRequired =
                frame[2] === false &&
                typeof frame[3] === "string" &&
                frame[3].indexOf("auth-required:") === 0;
              if (authRequired && !eventResent && !NbreadSigner.isRedirectSigner()) {
                return;
              }
              finish(); // the relay answered for OUR event — done either way
            } else if (authEventId !== null && frame[1] === authEventId) {
              if (frame[2] === true) {
                eventResent = true;
                sendEvent();
              } else {
                finish();
              }
            }
            return;
          }
          if (frame[0] === "AUTH" && typeof frame[1] === "string" && !authTried) {
            authTried = true;
            handleAuthChallenge(frame[1]);
          }
          // NOTICE / CLOSED / anything else: keep waiting for the deadline.
        }
        try {
          ws = new WebSocket(url);
        } catch (e) {
          resolve();
          return;
        }
        deadline(3000);
        ws.onopen = function () {
          sendEvent();
        };
        ws.onmessage = function (m) {
          try {
            handleFrame(JSON.parse(m.data));
          } catch (e) {
            finish(); // unparseable frame — treat like "any reply ends it"
          }
        };
        ws.onerror = finish;
        ws.onclose = finish;
      });
    });
    return Promise.all(attempts);
  }

  // POST the signed event to the server mirror (updates the stored profile
  // immediately). Throws with the server's error message on rejection.
  async function postMirror(event) {
    var res = await fetch("/api/mirror", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    var data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* non-JSON error body */
    }
    if (!res.ok) {
      throw new Error(data.error || data.result || "mirror failed (" + res.status + ")");
    }
    return data.result;
  }

  function leaveSaved() {
    window.location.href = "/dashboard/profile?published=1";
  }

  async function signMirrorBroadcast(unsigned) {
    if (NbreadSigner.isRedirectSigner()) {
      // NIP-55 (Amber): signer.js completes the unsigned event, stashes the
      // pending record (kind 0 buckets as "publish"), and NAVIGATES to the
      // Amber intent — the promise never settles; the resume block below
      // picks the flow back up after the redirect.
      say("Handing off to your signing app…");
      await NbreadSigner.signEvent(unsigned);
      return; // unreachable with nip55; defensive for future redirect backends
    }
    say("Waiting for your signature…");
    var signed = await NbreadSigner.signEvent(unsigned);
    say("Publishing your profile…");
    var result = await postMirror(signed);
    if (result !== "stored") {
      throw new Error("unexpected mirror result: " + result);
    }
    say("Broadcasting to your relays…");
    await broadcast(signed);
    leaveSaved();
  }

  // --- NIP-55 resume + no-resign retry --------------------------------------
  // Same shape as editor.js: a resumed signed event that fails at the mirror
  // stays armed in these closure variables (and re-stashed under signer.js's
  // pending key) so the next click retries WITHOUT re-signing.
  var resumedSigned = null; // verified signed kind 0 awaiting publish retry

  function restashResumed() {
    try {
      var record = globalThis.NbreadSignerCore.makePendingRecord({
        kind: "publish",
        unsigned: resumedSigned,
        returnTo: location.href,
        nowSec: nowSeconds(),
      });
      localStorage.setItem("nbread:nip55:pending", JSON.stringify(record));
    } catch (e) {
      /* quota/private mode — in-memory retry still available this load */
    }
  }

  function discardResumed() {
    resumedSigned = null;
    try {
      localStorage.removeItem("nbread:nip55:pending");
    } catch (e) {
      /* nothing stashed */
    }
  }

  async function publishResumed() {
    var signed = resumedSigned;
    say("Publishing your profile…");
    var result = await postMirror(signed);
    if (result !== "stored") {
      throw new Error("unexpected mirror result: " + result);
    }
    resumedSigned = null;
    try {
      localStorage.removeItem("nbread:nip55:pending");
    } catch (e) {
      /* nothing stashed */
    }
    say("Broadcasting to your relays…");
    await broadcast(signed);
    leaveSaved();
  }

  async function retryResumedOrDiscard() {
    try {
      await publishResumed();
    } catch (e) {
      discardResumed();
      throw new Error(
        String((e && e.message) || e) +
          " — the saved signature was discarded; press the button again to sign a new version.",
      );
    }
  }

  // Consume a NIP-55 callback exactly once, before the button handler is
  // wired. Only kind 0 publish records belong to this page (the pending
  // record's returnTo pins the callback to the URL that stashed it).
  (function resumeNip55() {
    var pending = null;
    try {
      pending = NbreadSigner.resumePending();
    } catch (e) {
      return; // malformed callback — nothing to resume
    }
    if (!pending) return;
    if (pending.error) {
      if (pending.kind !== "login") {
        say("Signing cancelled or failed: " + pending.error);
      }
      return;
    }
    if (pending.kind !== "publish") return;
    if (!pending.signed || pending.signed.kind !== 0) return;
    resumedSigned = pending.signed;
    say("Resuming…");
    if (publishBtn) publishBtn.disabled = true;
    publishResumed()
      .catch(function (e) {
        restashResumed();
        say(
          String((e && e.message) || e) +
            ' — press "Sign & publish profile" again to retry without re-signing.',
        );
      })
      .then(function () {
        if (publishBtn) publishBtn.disabled = false;
      });
  })();

  // Publish goes through the button, never a native form submit.
  form.addEventListener("submit", function (e) {
    e.preventDefault();
  });

  if (publishBtn) {
    publishBtn.addEventListener("click", async function () {
      publishBtn.disabled = true;
      try {
        // Retry path for a resumed NIP-55 publish whose mirror POST failed.
        if (resumedSigned) {
          await retryResumedOrDiscard();
          return;
        }
        if (!(await ensureSigner())) return;
        var metadata = buildMetadata();
        if (
          Object.keys(metadata).length === 0 &&
          !window.confirm(
            "All fields are empty — publish an empty profile? This clears your name, picture, and bio everywhere.",
          )
        ) {
          return;
        }
        await signMirrorBroadcast({
          kind: 0,
          created_at: nextCreatedAt(),
          tags: [],
          content: JSON.stringify(metadata),
        });
        return;
      } catch (e) {
        say(String((e && e.message) || e));
      } finally {
        publishBtn.disabled = false;
      }
    });
  }

  // --- Blossom upload wiring (picture / banner) -----------------------------
  // Each "Upload image" button opens its hidden file input; a chosen file is
  // uploaded direct-from-browser (public/js/blossom.js) and the returned URL
  // dropped into the matching text field. Redirect signers are rejected by
  // uploadBlob itself with a paste-a-URL message.
  var uploadButtons = document.querySelectorAll("button[data-upload-target]");
  Array.prototype.forEach.call(uploadButtons, function (btn) {
    var targetId = btn.getAttribute("data-upload-target");
    var fileInput = document.querySelector(
      'input[type="file"][data-upload-for="' + targetId + '"]',
    );
    var urlInput = document.getElementById(targetId);
    if (!fileInput || !urlInput) return;

    btn.addEventListener("click", function () {
      fileInput.click();
    });

    fileInput.addEventListener("change", async function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = ""; // allow re-picking the same file after a failure
      if (!file) return;
      if (!(await ensureSigner())) return;
      btn.disabled = true;
      say("Uploading image…");
      try {
        var result = await NbreadBlossom.uploadBlob(file, {
          signer: NbreadSigner,
        });
        urlInput.value = result.url;
        say("Image uploaded — remember to publish your profile.");
      } catch (e) {
        say(String((e && e.message) || e));
      } finally {
        btn.disabled = false;
      }
    });
  });
})();
