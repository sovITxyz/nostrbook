# public/js

Client-side signer glue plus the hand-rolled editor (no build step at serve
time, no runtime dependencies — every file is a plain IIFE served as-is):

- `signer-core.js` — DOM-free pure helpers (`globalThis.NbreadSignerCore`):
  nsec decoding, pubkey normalization, the NIP-55 (Amber) intent URL
  builder + callback parser, and the pending-record make/validate pair the
  redirect flow persists across page unloads. Unit-tested directly.
- `signer.js` — the dispatcher (`globalThis.NbreadSigner`): one signing
  seam (`ready`/`getPublicKey`/`signEvent`) over four backends — NIP-07
  extension, pasted local key (signs in-page, key never leaves the browser),
  NIP-55 Amber redirects (incl. `resumePending()` after the callback), and
  a `register()`ed NIP-46 backend. Owns the `nbread:signer:*` localStorage
  keys and `forget()`.
- `signer-nip46.js` — NIP-46 remote-signer client
  (`globalThis.NbreadNip46`): bunker:// / nostrconnect:// pairing, the
  NIP-44 (with legacy NIP-04 fallback) request envelope, auth_url
  surfacing, and schnorr verification of every returned event; registers
  itself as the dispatcher's "nip46" backend on load.
- `login.js` (P4) — fetches a one-time challenge, signs the kind 22242 auth
  event via `NbreadSigner`, POSTs it to `/login`. Also owns the login-page
  method picker and per-method panels.
- `editor.js` (P5) — builds kind 30023 / kind 5 events, signs via
  `NbreadSigner`, broadcasts to relays, POSTs to `/api/mirror`. Also owns the
  server-rendered preview fetch: it listens for the
  `nbread:preview-requested` event (dispatched by the Preview tab),
  caches the last previewed value, and calls
  `window.NbreadDraft.clear()` after a successful publish/delete.
- `editor-md.js` — DOM-free markdown text-manipulation core
  (`globalThis.NbreadEditorMd`): every helper maps
  `(value, selStart, selEnd, ...)` to a
  `{ start, end, text, selStart, selEnd }` replacement instruction (or
  null = let native behavior run). Unit-tested directly in
  `test/unit/editor-md.spec.ts`.
- `editor-toolbar.js` — DOM glue for the formatting toolbar (roving
  tabindex), keyboard shortcuts, list Enter/Tab behavior, URL-paste
  linking, the char/word counter, Write/Preview tabs, and localStorage
  draft autosave (`window.NbreadDraft`). All textarea mutations go
  through one `execCommand("insertText")` seam so native undo survives.

Load order matters (classic `<script src>` tags, no modules). The signer
stack always loads first: `vendor/nostr-crypto.js` → `signer-core.js` →
`signer.js` → `signer-nip46.js`. The login page then adds `login.js`; the
editor page adds `editor-md.js` → `editor-toolbar.js` → `editor.js`.

## vendor/

- `vendor/nostr-crypto.js` — GENERATED-BUT-COMMITTED crypto bundle
  (`globalThis.NbreadCrypto`): hex/utf-8/base64 utils, bech32 + npub/nsec
  codecs (same BIP-173 implementation as `src/nostr/nip19.ts`), NIP-01
  event ids byte-identical to `src/nostr/event.ts`, BIP-340 schnorr
  sign/verify, NIP-44 v2, and legacy NIP-04. Built from
  `scripts/vendor/crypto-entry.js` by `npm run build:vendor`
  (esbuild, devDependency only — deploy never builds) and committed
  unminified for auditability. Do NOT edit the artifact by hand: edit the
  entry, rebuild, and commit both. CI rebuilds and fails on drift
  (`git diff --exit-code` plus a `git status --porcelain` check so new
  untracked build output also fails). All randomness comes from
  `crypto.getRandomValues`. Unit-tested against the server primitives,
  nostr-tools, and the official NIP-44 v2 vectors in
  `test/unit/vendor-crypto.spec.ts`.
