import { Layout } from "../layout";
import { SiteHeader, SiteFooter } from "./chrome";

/**
 * Login page: signer method picker + per-method panels. All logic lives in
 * /js/login.js on top of the NbreadSigner dispatcher (signer.js): fetch a
 * one-time challenge, sign a kind 22242 event with the chosen backend
 * (NIP-07 extension, NIP-46 remote signer, NIP-55 Amber redirect, or a
 * pasted local key), POST it to /login.
 *
 * Every panel is server-rendered statically and hidden via the `hidden`
 * attribute — login.js reveals the right one. No inline executable script
 * (CSP: script-src 'self'); nothing here renders user/relay-sourced values.
 */
export function LoginPage() {
  return (
    <Layout title="Sign in — nbread.lol">
      <SiteHeader />
      <main>
        <h1>Sign in</h1>
        <p>
          Sign in with your Nostr key. Choose how you want to sign: a{" "}
          <a
            href="https://github.com/nostr-protocol/nips/blob/master/07.md"
            rel="noopener noreferrer"
          >
            NIP-07 browser extension
          </a>{" "}
          (Alby, nos2x, …), a remote signer, Amber on Android, or a pasted
          key. Whichever you pick, you only sign a one-time login challenge.
        </p>
        <noscript>
          <p>Signing in requires JavaScript — enable it and reload this page.</p>
        </noscript>

        {/* Shown when a signer is already configured in this browser. */}
        <div id="signer-current" class="signer-panel" hidden>
          <p>
            Signed-in method: <span id="current-method-label"></span>{" "}
            <span id="current-npub" class="signer-npub"></span>
          </p>
          <p>
            <button id="current-signin" type="button">
              Sign in
            </button>{" "}
            <button id="current-switch" type="button">
              Use a different method
            </button>{" "}
            <button id="current-forget" type="button" class="danger">
              Forget this signer
            </button>
          </p>
        </div>

        <div id="signer-picker" class="signer-picker" hidden>
          <button type="button" data-method="nip07">
            Browser extension (NIP-07)
          </button>
          <button type="button" data-method="nip46">
            Remote signer — Amber, nsec.app (NIP-46)
          </button>
          <button type="button" data-method="nip55">
            Amber on this device (Android)
          </button>
          <button type="button" data-method="local">
            Paste secret key (not recommended)
          </button>
        </div>

        <section id="panel-nip07" class="signer-panel" hidden>
          <p>
            Use a NIP-07 browser extension (Alby, nos2x, …) — your key never
            leaves it; you only sign a one-time login challenge.
          </p>
          <button id="login-button" type="button">
            Sign in with extension
          </button>
        </section>

        <section id="panel-nip46" class="signer-panel" hidden>
          <p>
            Paste the <code>bunker://</code> URI from your remote signer
            (Amber, nsec.app, …):
          </p>
          <p>
            <input
              id="nip46-uri"
              type="text"
              autocomplete="off"
              spellcheck={false}
              placeholder="bunker://…"
            />{" "}
            <button id="nip46-connect" type="button">
              Connect
            </button>
          </p>
          <p>
            Or generate a link to paste into your signer instead — it connects
            back to this page:
          </p>
          <p>
            <button id="nip46-generate" type="button">
              Generate nostrconnect:// link
            </button>{" "}
            <input id="nip46-generated" type="text" readonly />
          </p>
        </section>

        <section id="panel-nip55" class="signer-panel" hidden>
          <p>
            Amber holds your key on this Android device. You will be sent to
            Amber to approve, then returned here to finish signing in.
          </p>
          <button id="nip55-signin" type="button">
            Sign in with Amber
          </button>
        </section>

        <section id="panel-local" class="signer-panel" hidden>
          <p class="danger">
            Your secret key will be stored unencrypted in this browser's
            localStorage. Anyone with access to this browser or its profile
            data can read it and take over your Nostr identity. Prefer a
            signer app (Amber, nsec.app) or a browser extension if you can.
          </p>
          <p>
            <input
              id="nsec-input"
              type="password"
              autocomplete="off"
              placeholder="nsec1… or 64-hex"
            />{" "}
            <button id="nsec-import" type="button">
              Use this key
            </button>
          </p>
          <div id="nsec-confirm-step" hidden>
            <p>
              This key is <span id="nsec-npub" class="signer-npub"></span>
            </p>
            <p>
              <button id="nsec-confirm" type="button">
                Sign in as this key
              </button>{" "}
              <button id="nsec-cancel" type="button">
                Cancel
              </button>
            </p>
          </div>
        </section>

        <p id="login-status" role="status" aria-live="polite"></p>
        <script src="/js/vendor/nostr-crypto.js"></script>
        <script src="/js/signer-core.js"></script>
        <script src="/js/signer.js"></script>
        <script src="/js/signer-nip46.js"></script>
        <script src="/js/login.js"></script>
      </main>
      <SiteFooter />
    </Layout>
  );
}
