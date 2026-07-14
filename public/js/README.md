# public/js

Client-side NIP-07 glue plus the hand-rolled editor (no build step, no
dependencies — every file is a plain IIFE served as-is):

- `login.js` (P4) — fetches a one-time challenge, signs the kind 22242 auth
  event via `window.nostr`, POSTs it to `/login`. Keys never leave the
  extension.
- `editor.js` (P5) — builds kind 30023 / kind 5 events, signs via the
  extension, broadcasts to relays, POSTs to `/api/mirror`. Also owns the
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

Load order on the editor page matters: `editor-md.js` →
`editor-toolbar.js` → `editor.js`.
