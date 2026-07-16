// Editor glue: build a kind 30023 (long-form post) or kind 5 (delete)
// event, sign it through the NbreadSigner abstraction (NIP-07 extension,
// NIP-46 remote bunker, NIP-55/Amber redirect, or a stored local key),
// broadcast it to the user's relays client-side (best-effort, with NIP-42
// AUTH support for relays that challenge), and POST the signed event to
// /api/mirror so the blog updates immediately. No secret key ever enters
// this file; the server only ever sees signed events. NIP-55 signing
// round-trips through a full page redirect — the resume block below picks
// the flow back up when Amber sends the user back.
(function () {
  "use strict";

  var cfgEl = document.getElementById("editor-config");
  var form = document.getElementById("editor-form");
  if (!cfgEl || !form) return;

  var cfg;
  try {
    cfg = JSON.parse(cfgEl.textContent || "{}");
  } catch (e) {
    return;
  }

  var titleEl = document.getElementById("post-title");
  var slugEl = document.getElementById("post-slug");
  var summaryEl = document.getElementById("post-summary");
  var contentEl = document.getElementById("post-content");
  var statusEl = document.getElementById("editor-status");
  var previewSection = document.getElementById("preview");
  var previewBody = document.getElementById("preview-body");
  var previewBtn = document.getElementById("preview-button");
  var publishBtn = document.getElementById("publish-button");
  var deleteBtn = document.getElementById("delete-button");

  function say(message) {
    if (statusEl) statusEl.textContent = message;
  }

  // A signer must be configured AND belong to the identity this dashboard
  // session is signed in as — publishing with a different key would scatter
  // posts across identities. Says the problem and returns false when not
  // usable.
  //
  // NIP-55 note: getPublicKey() with no stored pubkey would REDIRECT to
  // Amber, which must never happen from this guard. It cannot: the nip55
  // backend's ready() only reports ok when a pubkey is already stored (no
  // stored pubkey reads as not-ready below), so getPublicKey() here is a
  // pure storage read for nip55.
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

  // An edit must WIN the replaceable slot: created_at strictly greater than
  // the stored version's (equal timestamps tie-break on id and can lose).
  function nextCreatedAt() {
    var prev = typeof cfg.prevCreatedAt === "number" ? cfg.prevCreatedAt : 0;
    return Math.max(nowSeconds(), prev + 1);
  }

  // Mirrors the server's heading-slug shape (ASCII, hyphens, max 64).
  function slugify(text) {
    var s = String(text || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    return s || "post-" + nowSeconds();
  }

  // Best-effort broadcast: publish the signed event to every configured
  // relay, tolerating dead relays. Resolves once every attempt has finished
  // (OK for the event, error, close, or per-relay deadline) — never rejects.
  //
  // NIP-42: a relay may answer ["AUTH", <challenge>] instead of accepting
  // the EVENT (nbread's first-party relay does; public relays generally
  // don't). Once per connection we then sign a kind-22242 auth event with
  // the active signer, send ["AUTH", <signed>], and on its accepting OK
  // resend the EVENT. Redirect signers (NIP-55) are excluded — signing
  // would navigate away mid-broadcast — those connections simply wait out
  // the original deadline. The whole AUTH path is best-effort: a parse
  // error or signing failure never turns into a rejection.
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
          // A redirect signer (NIP-55) would unload the page mid-broadcast
          // — unacceptable. Skip AUTH; the original deadline still runs.
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
              // NIP-42 pre-auth rejection: relays like strfry answer the
              // unauthenticated EVENT with OK false "auth-required:" and
              // send ["AUTH", <challenge>] alongside (either order). That
              // OK must NOT end the attempt while our AUTH round can still
              // complete and resend the EVENT — the deadline still bounds
              // the wait. After the post-auth resend (or with a redirect
              // signer that cannot AUTH mid-broadcast), any OK is final.
              var authRequired =
                frame[2] === false &&
                typeof frame[3] === "string" &&
                frame[3].indexOf("auth-required:") === 0;
              if (authRequired && !eventResent && !NbreadSigner.isRedirectSigner()) {
                return;
              }
              finish(); // the relay answered for OUR event — done either way
            } else if (authEventId !== null && frame[1] === authEventId) {
              // Auth accepted -> the relay will take the event now; resend
              // it. Auth rejected -> nothing more to try on this relay.
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
            finish(); // unparseable frame — treat like the old "any reply ends it"
          }
        };
        ws.onerror = finish;
        ws.onclose = finish;
      });
    });
    return Promise.all(attempts);
  }

  // POST the signed event to the server mirror (the authoritative copy the
  // blog renders from). Throws with the server's error message on rejection.
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

  async function signMirrorBroadcast(unsigned, progress) {
    if (NbreadSigner.isRedirectSigner()) {
      // NIP-55 (Amber): signEvent completes the unsigned event itself —
      // signer.js fills in the stored pubkey and precomputes the NIP-01 id
      // via NbreadSignerCore.completeUnsigned — stashes the pending record
      // ({kind} inferred from unsigned.kind: 5 -> "delete", else
      // "publish"), and NAVIGATES to the Amber intent. The returned promise
      // never settles, so execution ends right here. The draft survives via
      // editor-toolbar.js's beforeunload flush (deliberately NOT cleared),
      // and the resume block below picks the flow back up after Amber
      // redirects back to this page.
      say("Handing off to your signing app…");
      await NbreadSigner.signEvent(unsigned);
      return; // unreachable with nip55; defensive for future redirect backends
    }
    say("Waiting for your signature…");
    var signed = await NbreadSigner.signEvent(unsigned);
    say(progress);
    var result = await postMirror(signed);
    if (result !== "stored") {
      throw new Error("unexpected mirror result: " + result);
    }
    say("Broadcasting to your relays…");
    await broadcast(signed);
  }

  // --- NIP-55 resume + no-resign retry --------------------------------------
  // When Amber redirects back with a signature, NbreadSigner.resumePending()
  // (called once, below, BEFORE the button handlers are wired) returns the
  // schnorr-verified signed event. Publishing it can still fail at the
  // mirror; the signed event is then kept in these closure variables so the
  // next Publish/Delete click retries mirror+broadcast WITHOUT re-signing —
  // the user already approved this exact event in Amber once.
  var resumedSigned = null; // verified signed event awaiting publish retry
  var resumedKind = null; // "publish" | "delete"

  // A resumed event belongs to this editor page when its slug matches the
  // page's post: kind 30023 carries it in the d-tag, kind 5 in the a-tag
  // ("30023:<pubkey>:<slug>"). New-post pages (cfg.slug === "") accept any
  // resumed publish — the pending record was stashed by this same URL and
  // the slug was derived at sign time.
  function resumedSlugMatches(signed) {
    if (!cfg.slug) return true;
    var tags = Array.isArray(signed.tags) ? signed.tags : [];
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      if (!Array.isArray(t)) continue;
      if (signed.kind === 30023 && t[0] === "d") return t[1] === cfg.slug;
      if (signed.kind === 5 && t[0] === "a") {
        var parts = String(t[1] || "").split(":");
        return parts.length >= 3 && parts.slice(2).join(":") === cfg.slug;
      }
    }
    return false;
  }

  // Persist the still-unpublished signed event back under signer.js's
  // pending key ("nbread:nip55:pending"): resumePending() consumed the
  // record one-shot, and losing an already-approved signature to a stray
  // reload would force the user through Amber again. makePendingRecord
  // accepts the signed event as `unsigned` because it carries the
  // precomputed pubkey + id it validates (the extra sig field is inert).
  // Best-effort — the closure retry path above works without it.
  function restashResumed() {
    try {
      var record = globalThis.NbreadSignerCore.makePendingRecord({
        kind: resumedKind,
        unsigned: resumedSigned,
        returnTo: location.href,
        nowSec: nowSeconds(),
      });
      localStorage.setItem("nbread:nip55:pending", JSON.stringify(record));
    } catch (e) {
      /* quota/private mode — in-memory retry still available this load */
    }
  }

  // Drop the armed no-resign retry entirely: closure state AND the
  // re-stashed pending record. After this the next Publish/Delete click
  // takes the fresh sign path, picking up the form's current content.
  function discardResumed() {
    resumedSigned = null;
    resumedKind = null;
    try {
      localStorage.removeItem("nbread:nip55:pending");
    } catch (e) {
      /* nothing stashed */
    }
  }

  // Retry path for the button handlers: push the armed resumed event once
  // more; if the mirror rejects it AGAIN (a deterministic rejection would
  // otherwise lock the buttons into re-POSTing the same doomed event
  // forever), discard the signature so the next click signs the current
  // draft fresh, and say so.
  async function retryResumedOrDiscard() {
    try {
      await publishResumed();
    } catch (e) {
      discardResumed();
      throw new Error(
        String((e && e.message) || e) +
          " — the saved signature was discarded; edit if needed and press the button again to sign a new version.",
      );
    }
  }

  // Push the already-signed resumed event through mirror + broadcast, then
  // leave for the dashboard. Retry state is cleared only AFTER the mirror
  // accepted the event, so a thrown mirror error keeps the retry armed.
  async function publishResumed() {
    var signed = resumedSigned;
    say(resumedKind === "delete" ? "Deleting…" : "Publishing to nbread.lol…");
    var result = await postMirror(signed);
    if (result !== "stored") {
      throw new Error("unexpected mirror result: " + result);
    }
    resumedSigned = null;
    resumedKind = null;
    try {
      localStorage.removeItem("nbread:nip55:pending");
    } catch (e) {
      /* nothing stashed */
    }
    say("Broadcasting to your relays…");
    await broadcast(signed);
    if (window.NbreadDraft) window.NbreadDraft.clear();
    window.location.href = "/dashboard";
  }

  // Consume a NIP-55 callback exactly once, before the button handlers are
  // wired. resumePending() returns null when the URL carries no callback.
  (function resumeNip55() {
    var pending = null;
    try {
      pending = NbreadSigner.resumePending();
    } catch (e) {
      return; // malformed callback — nothing to resume
    }
    if (!pending) return;
    if (pending.error) {
      // Cancelled/expired/failed verification: nothing was published. Say
      // so BEFORE the kind guard — a lost/replayed pending record comes
      // back with kind null and would otherwise reset the page silently
      // after the Amber round-trip. Login-flow errors belong to /login.
      // The draft restore flow (editor-toolbar.js) still offers the content.
      if (pending.kind !== "login") {
        say("Signing cancelled or failed: " + pending.error);
      }
      return;
    }
    if (pending.kind !== "publish" && pending.kind !== "delete") return;
    if (!pending.signed) return;
    resumedSigned = pending.signed;
    resumedKind = pending.kind;
    say("Resuming…");
    // Hold the buttons while the resume publish is in flight so a click
    // cannot race a second copy of the same POST.
    if (publishBtn) publishBtn.disabled = true;
    if (deleteBtn) deleteBtn.disabled = true;
    publishResumed()
      .catch(function (e) {
        // Keep the signature: closure state is the live retry path, the
        // re-stash survives a reload of THIS page (10-minute TTL).
        restashResumed();
        say(
          String((e && e.message) || e) +
            " — press " +
            (resumedKind === "delete"
              ? '"Delete post"'
              : cfg.mode === "edit"
                ? '"Sign & republish"'
                : '"Sign & publish"') +
            " again to retry without re-signing.",
        );
      })
      .then(function () {
        if (publishBtn) publishBtn.disabled = false;
        if (deleteBtn) deleteBtn.disabled = false;
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
        // Retry path for a resumed NIP-55 publish whose mirror POST failed:
        // the event is already signed and verified — skip signing entirely.
        if (
          resumedSigned &&
          resumedKind === "publish" &&
          resumedSlugMatches(resumedSigned)
        ) {
          await retryResumedOrDiscard();
          return;
        }
        if (!(await ensureSigner())) return;
        var title = (titleEl && titleEl.value ? titleEl.value : "").trim();
        var content = contentEl && contentEl.value ? contentEl.value : "";
        if (!title) {
          say("A title is required.");
          return;
        }
        if (!content.trim()) {
          say("Write something first.");
          return;
        }
        var slug =
          cfg.mode === "edit"
            ? cfg.slug
            : slugify((slugEl && slugEl.value.trim()) || title);
        var createdAt = nextCreatedAt();
        // First publication time survives edits (NIP-23 published_at).
        var publishedAt =
          typeof cfg.publishedAt === "number" && cfg.publishedAt > 0
            ? cfg.publishedAt
            : createdAt;
        var tags = [
          ["d", slug],
          ["title", title],
          ["published_at", String(publishedAt)],
        ];
        var summary = (summaryEl && summaryEl.value ? summaryEl.value : "").trim();
        if (summary) tags.push(["summary", summary]);

        await signMirrorBroadcast(
          {
            kind: 30023,
            created_at: createdAt,
            tags: tags,
            content: content,
          },
          "Publishing to nbread.lol…",
        );
        if (window.NbreadDraft) window.NbreadDraft.clear();
        window.location.href = "/dashboard";
        return;
      } catch (e) {
        say(String((e && e.message) || e));
      } finally {
        publishBtn.disabled = false;
      }
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener("click", async function () {
      if (
        !window.confirm(
          "Delete this post? A signed deletion event (kind 5) will be published to your relays and the post will disappear from your blog.",
        )
      ) {
        return;
      }
      deleteBtn.disabled = true;
      try {
        // Same no-resign retry as the publish button, for a resumed delete.
        if (
          resumedSigned &&
          resumedKind === "delete" &&
          resumedSlugMatches(resumedSigned)
        ) {
          await retryResumedOrDiscard();
          return;
        }
        if (!(await ensureSigner())) return;
        var tags = [];
        if (typeof cfg.eventId === "string" && cfg.eventId) {
          tags.push(["e", cfg.eventId]);
        }
        tags.push(["a", "30023:" + cfg.pubkey + ":" + cfg.slug]);

        await signMirrorBroadcast(
          {
            kind: 5,
            created_at: nextCreatedAt(),
            tags: tags,
            content: "Deleted via nbread.lol",
          },
          "Deleting…",
        );
        if (window.NbreadDraft) window.NbreadDraft.clear();
        window.location.href = "/dashboard";
        return;
      } catch (e) {
        say(String((e && e.message) || e));
      } finally {
        deleteBtn.disabled = false;
      }
    });
  }

  // Preview renders lazily — on Preview-tab activation (editor-toolbar.js
  // dispatches "nbread:preview-requested") or via a legacy
  // #preview-button when one exists — and is cached on exact string
  // identity: switching tabs without edits costs no request and none of the
  // preview rate-limit budget.
  var lastPreviewedValue = null;
  var previewSeq = 0;

  async function runPreview() {
    var value = contentEl && contentEl.value ? contentEl.value : "";
    if (value === lastPreviewedValue) return;
    // Sequence guard: only the newest in-flight request may touch the DOM
    // or the cache, so an out-of-order response can't present (and pin)
    // stale markdown as current.
    var seq = ++previewSeq;
    try {
      say("Rendering preview…");
      var res = await fetch("/dashboard/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: value }),
      });
      if (seq !== previewSeq) return;
      if (res.status === 429) {
        // Keep whatever preview is already on screen: only the refresh is
        // throttled, publishing itself is not.
        say(
          "Preview rate-limited — published posts always use the server pipeline; try again in a few minutes.",
        );
        return;
      }
      if (!res.ok) {
        throw new Error("preview failed (" + res.status + ")");
      }
      // Server-sanitized HTML from the exact publish pipeline — what you
      // see here is byte-identical to what readers will get.
      var html = await res.text();
      if (seq !== previewSeq) return;
      if (previewBody) previewBody.innerHTML = html;
      // With tabs present, panel visibility belongs to the tab switcher —
      // the user may have gone back to Write mid-fetch. Only force the
      // panel visible in the legacy button-only layout, or when the
      // Preview tab is still the selected one.
      var tabPreview = document.getElementById("tab-preview");
      if (
        previewSection &&
        (!tabPreview || tabPreview.getAttribute("aria-selected") === "true")
      ) {
        previewSection.hidden = false;
      }
      lastPreviewedValue = value;
      say("");
    } catch (e) {
      if (seq === previewSeq) say(String((e && e.message) || e));
    }
  }

  document.addEventListener("nbread:preview-requested", function () {
    runPreview();
  });

  if (previewBtn) {
    previewBtn.addEventListener("click", async function () {
      previewBtn.disabled = true;
      try {
        await runPreview();
      } finally {
        previewBtn.disabled = false;
      }
    });
  }
})();
