# Manual signer test checklist

Real-device acceptance checks for the signer expansion (NIP-46 remote
signers, NIP-55 Amber, pasted local key) plus the NIP-07 regression. Run
against a deployed instance (workers.dev preview or nbread.lol) — the
NIP-55 flows need a real Android device with Amber installed, and the
NIP-46 flows need live wss:// relays. Automated coverage (unit +
integration) already gates CI; this list covers only what a browser and a
phone can prove.

Conventions used below:

- "editor" = `/dashboard/posts/new` or `/dashboard/editor?slug=…`
- Signer state lives under `localStorage` keys prefixed `nbread:` — clear
  them (or use "Forget this signer" on `/login`) to reset between sections.

## 1. Amber via bunker:// (NIP-46) — issue #2 acceptance

End-to-end on any browser (desktop is fine; Amber runs on the phone and
talks over relays).

- [ ] In Amber, create a bunker:// connection URI and copy it.
- [ ] On `/login`, choose "Remote signer — Amber, nsec.app (NIP-46)",
      paste the `bunker://…` URI, press Connect; approve the connect
      request in Amber.
- [ ] Sign-in completes: approving the kind 22242 challenge in Amber lands
      you on `/dashboard` with your handle/npub shown.
- [ ] Publish: write a post in the editor, press "Sign & publish", approve
      the kind 30023 in Amber → redirected to `/dashboard`, post renders at
      `https://<handle>.nbread.lol/<slug>`.
- [ ] Edit: open the same post, change the body, "Sign & republish",
      approve in Amber → the blog page shows the new content (same slug).
- [ ] Delete: "Delete post", confirm the dialog, approve the kind 5 in
      Amber → post disappears from the blog and the dashboard list.

## 2. nsec.app remote signer (NIP-46, incl. auth_url)

- [ ] Pair via `bunker://` from nsec.app (or "Generate nostrconnect://
      link" and paste it into nsec.app) on `/login`.
- [ ] When nsec.app answers with an auth_url, the login page surfaces the
      approval link as a link/prompt — it must NOT auto-navigate. Open it,
      approve, and confirm the original request then completes.
- [ ] Sign in, publish a post, and delete it — each sign request appears
      in nsec.app for approval and completes after approving.

## 3. NIP-55 — Amber on Android Chrome

All on the phone; the flow is full-page redirects into the Amber app and
back.

- [ ] Sign in: `/login` → "Amber on this device (Android)" → "Sign in with
      Amber" → Amber opens (get_public_key), approve → returned to
      `/login`, then approve the challenge signature → session established.
- [ ] Publish: editor → "Sign & publish" → page hands off to Amber →
      approve → returned to the editor, which resumes ("Resuming…"),
      mirrors, broadcasts, and lands on `/dashboard`; post is live.
- [ ] Delete: open a post → "Delete post" → confirm → approve the kind 5
      in Amber → resumed on return, post gone.
- [ ] Cancel mid-sign: start a publish, but REJECT (or back out of) the
      request in Amber. Back in the editor the status says signing was
      cancelled, nothing was published, and the draft-notice offers to
      restore your text — restoring brings the full draft back.
- [ ] Oversized post: paste content past the 256 KiB publish cap (the
      counter turns red: "too large to publish") and attempt "Sign &
      publish" with Amber. The flow must refuse cleanly — either the
      intent hand-off fails or `/api/mirror` rejects the event on resume —
      with an error message, no partial publish, and the draft intact.
- [ ] Reload safety: after any completed Amber round-trip, reloading the
      page must not replay the signature (the callback params are stripped
      from the URL).

## 4. Pasted secret key (local) — desktop + Android

- [ ] Desktop: `/login` → "Paste secret key (not recommended)" → the red
      unencrypted-localStorage warning is visible → paste an `nsec1…` →
      the derived npub is shown for confirmation → "Sign in as this key"
      completes login.
- [ ] Publish and delete a post from the editor — signing happens in-page
      with no prompts and no redirects.
- [ ] "Forget this signer" on `/login` clears the stored key
      (`nbread:signer:nsec` gone from localStorage) and returns you to the
      method picker.
- [ ] Re-import: paste the same nsec again and sign in — works identically
      (and hex-form input works too).
- [ ] Repeat sign-in + publish on Android Chrome.

## 5. NIP-07 regression (Alby or nos2x)

Behavior must be identical to before the signer expansion.

- [ ] `/login` → "Browser extension (NIP-07)" → "Sign in with extension" →
      extension approval prompt → `/dashboard`.
- [ ] Publish, edit, and delete a post from the editor; each action
      prompts the extension once and completes.
- [ ] With the extension disabled, the panel reports that no NIP-07
      extension (window.nostr) was found instead of failing silently.

## 6. Negative checks (any signer unless noted)

- [ ] Expired challenge: fetch `/login`, wait more than 5 minutes (the
      nonce TTL is 300 s), then complete the sign-in — the server rejects
      the stale challenge and the page shows the error; retrying fresh
      succeeds.
- [ ] Dead bunker relay (NIP-46): pair using a `bunker://` URI whose relay
      is unreachable — the connect times out with a clear error (60 s
      request / 120 s pairing budget), no hang, no crash; the page stays
      usable.
- [ ] Wrong-identity signer vs session: sign in as key A, then on `/login`
      reconfigure the browser's signer to key B WITHOUT logging out. In the
      editor, publishing must refuse with "This browser's signer is a
      different Nostr identity than the one signed in…" and publish
      nothing.
- [ ] NIP-55 expired pending record: start an Amber sign, leave the phone
      idle past the pending TTL, then complete the callback — the editor
      reports the request expired, nothing publishes, the draft survives.

## 7. Devtools network audit (secret never leaves the page)

With the pasted-key (local) signer configured:

- [ ] Open devtools → Network, sign in, publish, and delete a post.
- [ ] Inspect EVERY request (fetches, WebSocket frames, and navigations,
      including `intent:`/callback URLs on Android): no request body, URL,
      or header ever contains the nsec or the 64-hex secret key — only
      signed events (pubkey + sig) and the public key ever leave the page.
- [ ] Repeat the sweep once for a NIP-46 session: WebSocket frames to the
      bunker relay carry only encrypted kind 24133 envelopes.
