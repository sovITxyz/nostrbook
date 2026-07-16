// Login glue on top of the NbreadSigner dispatcher: pick a signer method
// (NIP-07 extension / NIP-46 remote signer / NIP-55 Amber redirect / pasted
// local key), fetch a one-time challenge, sign a kind 22242 event, POST it
// to /login. The server only ever sees a signed event — no secret material
// leaves this page except into localStorage for the (explicitly warned)
// local-key method, which signer.js owns.
//
// Load order (login.tsx): vendor/nostr-crypto.js -> signer-core.js ->
// signer.js -> signer-nip46.js -> this file.
(function () {
  "use strict";

  var Signer = globalThis.NbreadSigner;
  var Core = globalThis.NbreadSignerCore;
  var Crypto = globalThis.NbreadCrypto;

  function $(id) {
    return document.getElementById(id);
  }

  var statusEl = $("login-status");
  var picker = $("signer-picker");
  if (!picker || !Signer) return; // not the login page / scripts missing

  // Relays used to mint client-initiated nostrconnect:// pairing URIs.
  // relay.nsec.app is the de-facto NIP-46 relay; the others are fallbacks
  // most signers can also reach.
  var NIP46_RELAYS = [
    "wss://relay.nsec.app",
    "wss://relay.damus.io",
    "wss://nos.lol",
  ];

  var METHOD_LABELS = {
    nip07: "Browser extension (NIP-07)",
    nip46: "Remote signer (NIP-46)",
    nip55: "Amber on this device (NIP-55)",
    local: "Local key in this browser",
  };

  var panels = {
    nip07: $("panel-nip07"),
    nip46: $("panel-nip46"),
    nip55: $("panel-nip55"),
    local: $("panel-local"),
  };
  var current = $("signer-current");

  function say(message) {
    if (statusEl) statusEl.textContent = message;
  }

  /**
   * Show the signer's approval URL as a clickable link. SECURITY: a hostile
   * remote signer controls this string — only exact https: URLs are ever
   * rendered (javascript:/data:/intent: and friends are rejected), and the
   * link is built via DOM APIs, never innerHTML.
   */
  function showAuthUrl(url) {
    var parsed;
    try {
      parsed = new URL(String(url));
    } catch (_) {
      say("The signer sent an unusable approval link.");
      return;
    }
    if (parsed.protocol !== "https:") {
      say("The signer sent an approval link this page refuses to open.");
      return;
    }
    if (!statusEl) return;
    statusEl.textContent = "Approve this connection in your signer: ";
    var a = document.createElement("a");
    a.href = parsed.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = parsed.href;
    statusEl.appendChild(a);
  }

  function hideAll() {
    picker.hidden = true;
    if (current) current.hidden = true;
    for (var k in panels) {
      if (panels[k]) panels[k].hidden = true;
    }
  }

  function showPicker() {
    hideAll();
    picker.hidden = false;
  }

  function showPanel(method) {
    hideAll();
    if (panels[method]) panels[method].hidden = false;
  }

  /** Show the "already configured" summary for the active method. */
  async function showCurrent(method) {
    hideAll();
    var label = $("current-method-label");
    var npubEl = $("current-npub");
    if (label) label.textContent = METHOD_LABELS[method] || method;
    if (npubEl) {
      npubEl.textContent = "";
      // nip07 is left blank: asking the extension for a pubkey pops its
      // connect dialog, which must wait until the user clicks Sign in.
      if (method !== "nip07") {
        try {
          var pk = await Signer.getPublicKey();
          npubEl.textContent = Crypto.npubEncode(pk);
        } catch (_) {
          /* summary stays blank — signing in will surface the real error */
        }
      }
    }
    if (current) current.hidden = false;
  }

  /** Entry view: configured-signer summary when usable, else the picker. */
  async function showEntry() {
    var m = Signer.method();
    if (m) {
      try {
        var r = await Signer.ready();
        if (r && r.ok) {
          await showCurrent(m);
          return;
        }
      } catch (_) {
        /* fall through to the picker */
      }
    }
    showPicker();
  }

  async function postLogin(signed) {
    say("Signing in…");
    var loginRes = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signed),
    });
    if (!loginRes.ok) {
      var err = {};
      try {
        err = await loginRes.json();
      } catch (_) {
        /* non-JSON error body */
      }
      throw new Error(err.error || "Login failed (" + loginRes.status + ")");
    }
    window.location.href = "/dashboard";
  }

  /**
   * The one sign-in routine every method funnels into: challenge ->
   * kind 22242 -> POST /login. The event shape is the login contract with
   * the server — do not change tags/content.
   *
   * With the nip55 method, Signer.signEvent stashes a pending record and
   * navigates away to Amber (the promise never settles); resume() picks the
   * flow back up after the redirect.
   */
  async function signIn() {
    say("Requesting challenge…");
    var challengeRes = await fetch("/login/challenge");
    if (!challengeRes.ok) {
      throw new Error("Could not get a challenge (" + challengeRes.status + ")");
    }
    var challenge = (await challengeRes.json()).challenge;

    if (Signer.method() === "nip07") {
      // Prompts the extension's connect dialog before the signing dialog,
      // so the user understands which identity they are signing in with.
      await Signer.getPublicKey();
    }

    say("Waiting for your signature…");
    var signed = await Signer.signEvent({
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        // Binds the signature to THIS service: the server refuses events
        // whose relay tag names any other host, so a signature phished
        // through a third-party site's login flow is useless here — and
        // the tag surfaces the destination in the signer's prompt.
        ["relay", "wss://" + location.host],
        ["challenge", challenge],
      ],
      // Human-readable statement of intent for the signing prompt
      // (transparency only — the relay tag is what the server enforces).
      content: "Log in to " + location.host,
    });

    await postLogin(signed);
  }

  /** Run an async action with a button disabled and errors -> status line. */
  function guarded(button, action) {
    return async function () {
      if (button) button.disabled = true;
      try {
        await action();
      } catch (e) {
        say(String((e && e.message) || e));
      } finally {
        if (button) button.disabled = false;
      }
    };
  }

  function on(id, action) {
    var button = $(id);
    if (button) button.addEventListener("click", guarded(button, action));
  }

  // --- Picker -----------------------------------------------------------------

  picker.addEventListener("click", function (ev) {
    var target = ev.target;
    while (target && target !== picker && !target.getAttribute("data-method")) {
      target = target.parentElement;
    }
    if (!target || target === picker) return;
    var method = target.getAttribute("data-method");
    if (method === "nip07") {
      showPanel("nip07");
      guarded(target, async function () {
        Signer.setMethod("nip07");
        var r = await Signer.ready();
        if (!r.ok) {
          say(r.reason || "No NIP-07 extension found.");
          return;
        }
        await signIn();
      })();
    } else if (method === "nip46" || method === "nip55" || method === "local") {
      say("");
      showPanel(method);
    }
  });

  // --- NIP-07 panel -------------------------------------------------------------

  on("login-button", async function () {
    Signer.setMethod("nip07");
    var r = await Signer.ready();
    if (!r.ok) {
      say(
        "No NIP-07 extension found. Install Alby or nos2x, then reload this page.",
      );
      return;
    }
    await signIn();
  });

  // --- NIP-46 panel -------------------------------------------------------------

  on("nip46-connect", async function () {
    var input = $("nip46-uri");
    var uri = input ? input.value.trim() : "";
    if (!/^bunker:\/\//i.test(uri)) {
      say("Paste a bunker:// URI from your signer first.");
      return;
    }
    say("Connecting to your remote signer…");
    await Signer.configureNip46(uri, { onAuthUrl: showAuthUrl });
    await signIn();
  });

  on("nip46-generate", async function () {
    var out = $("nip46-generated");
    say("Generating a pairing link…");
    await Signer.configureNip46(
      {
        relays: NIP46_RELAYS,
        onUri: function (uri) {
          if (out) {
            out.value = uri;
            try {
              out.select();
            } catch (_) {
              /* selection is a convenience only */
            }
          }
          say(
            "Paste this nostrconnect:// link into your signer, then approve the connection. Waiting…",
          );
        },
      },
      { onAuthUrl: showAuthUrl },
    );
    await signIn();
  });

  // --- NIP-55 (Amber) panel -------------------------------------------------------

  on("nip55-signin", async function () {
    Signer.setMethod("nip55");
    var r = await Signer.ready();
    if (!r.ok) {
      // First use: get_public_key round-trip. signer.js stashes a pending
      // "login" record and navigates to Amber; this promise never settles.
      // resume() continues the sign-in when Amber redirects back.
      say("Opening Amber…");
      await Signer.getPublicKey();
      return;
    }
    await signIn();
  });

  // --- Local key panel -------------------------------------------------------------

  // npub displayed by the confirm step. The confirm click re-decodes the
  // input and compares against this, so a key edited between "Use this key"
  // and the confirm (user, autofill, extension) can never be imported under
  // an npub the confirmation step did not attest.
  var confirmedNpub = null;

  function resetLocalPanel() {
    var input = $("nsec-input");
    var step = $("nsec-confirm-step");
    var npubEl = $("nsec-npub");
    if (input) input.value = "";
    if (npubEl) npubEl.textContent = "";
    if (step) step.hidden = true;
    confirmedNpub = null;
  }

  on("nsec-import", async function () {
    var input = $("nsec-input");
    var value = input ? input.value : "";
    var decoded;
    try {
      decoded = Core.decodeNsec(value);
    } catch (_) {
      say("That does not look like a valid key — expected nsec1… or 64 hex characters.");
      return;
    }
    confirmedNpub = decoded.npub;
    var npubEl = $("nsec-npub");
    if (npubEl) npubEl.textContent = decoded.npub;
    var step = $("nsec-confirm-step");
    if (step) step.hidden = false;
    say("Check the npub above, then confirm.");
  });

  on("nsec-confirm", async function () {
    var input = $("nsec-input");
    var value = input ? input.value : "";
    var decoded;
    try {
      decoded = Core.decodeNsec(value);
    } catch (_) {
      resetLocalPanel();
      say(
        "That does not look like a valid key anymore — paste it and press “Use this key” again.",
      );
      return;
    }
    if (decoded.npub !== confirmedNpub) {
      // The input changed after the npub was shown; force a re-check so
      // what gets imported is always the identity that was displayed.
      resetLocalPanel();
      say(
        "The key changed after it was checked — paste it and press “Use this key” again.",
      );
      return;
    }
    try {
      Signer.configureLocal(value);
    } finally {
      // The secret leaves the DOM immediately — success or failure.
      resetLocalPanel();
    }
    await signIn();
  });

  on("nsec-cancel", async function () {
    resetLocalPanel();
    say("");
  });

  // --- Configured-signer summary ---------------------------------------------------

  on("current-signin", async function () {
    await signIn();
  });

  on("current-switch", async function () {
    say("");
    showPicker();
  });

  on("current-forget", async function () {
    Signer.forget(Signer.method());
    say("");
    showPicker();
  });

  // --- Page load: resume a NIP-55 redirect, else show entry view --------------------

  async function init() {
    // Amber only exists on Android; hide its picker entry elsewhere.
    if (!/Android/i.test(navigator.userAgent)) {
      var nip55Button = picker.querySelector('[data-method="nip55"]');
      if (nip55Button) nip55Button.hidden = true;
    }

    var pending = null;
    try {
      pending = Signer.resumePending();
    } catch (_) {
      pending = null;
    }

    if (pending && pending.kind === "login") {
      if (pending.signed) {
        try {
          await postLogin(pending.signed);
          return; // navigating to /dashboard
        } catch (e) {
          say(String((e && e.message) || e));
          await showEntry();
          return;
        }
      }
      if (pending.error) {
        say(pending.error);
        await showEntry();
        return;
      }
      if (pending.pubkey) {
        // Amber's get_public_key round-trip completed (signer.js already
        // persisted the pubkey + method); continue straight into the
        // signing round-trip.
        try {
          await signIn();
          return;
        } catch (e) {
          say(String((e && e.message) || e));
          await showEntry();
          return;
        }
      }
    } else if (pending && pending.error) {
      // A callback whose pending record was lost/expired (kind null) still
      // deserves an explanation instead of a silently reset page.
      say(pending.error);
    }

    await showEntry();
  }

  init().catch(function (e) {
    say(String((e && e.message) || e));
    showPicker();
  });
})();
