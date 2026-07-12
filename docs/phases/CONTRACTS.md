## Shared contracts (include verbatim in EVERY subagent prompt)

**Stack**: one Cloudflare Worker + Static Assets (NOT Pages), Hono + hono/jsx SSR, TypeScript strict, vitest + `@cloudflare/vitest-pool-workers`. Free tier: 10ms CPU/request budget.

**Repo layout** (all product code under repo root):
```
LICENSE (AGPL-3.0)  README.md  wrangler.jsonc  package.json  tsconfig.json  vitest.config.ts
migrations/0001_init.sql ...        # D1, applied with wrangler d1 migrations
public/                             # static assets (css, js incl. login/editor NIP-07 glue)
src/index.ts                        # exports { fetch, scheduled }
src/app.ts                          # Hono app assembly
src/middleware/{guard,tenant,session,csrf,cache}.ts
src/nostr/{event.ts,nip19.ts,relay.ts}
src/services/{users,events,profiles,mirror,search,sessions,ratelimit}.ts
src/markdown/{index.ts,sanitize.ts,css-sanitize.ts}
src/routes/{tenant.ts,main.ts,api.ts,auth.ts,dashboard.ts,wellknown.ts}
src/views/**.tsx                    # layouts, tenant pages, main pages, dashboard
src/cron/refresh.ts
test/{unit,integration}/**.spec.ts  test/fixtures/   scripts/{gen-fixtures.ts,smoke.sh}
docs/phases/P0.md..P7.md            # these briefs, copied from this plan
```

**Bindings** (`wrangler.jsonc`): D1 `DB`; KV `KV`; vars `MAIN_HOST=nostrbook.net`, `ENVIRONMENT`, `TURNSTILE_SITE_KEY`, `RELAYS` (comma list: wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band); secrets `TURNSTILE_SECRET_KEY`; cron `*/15 * * * *`; routes `nostrbook.net/*` + `*.nostrbook.net/*` zone `nostrbook.net`; assets dir `public/` binding `ASSETS`.

**D1 schema** (migrations/0001_init.sql):
```sql
CREATE TABLE users    (pubkey TEXT PRIMARY KEY, handle TEXT UNIQUE COLLATE NOCASE,
                       claimed_at TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}',
                       blocked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE events   (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, kind INTEGER NOT NULL,
                       d_tag TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
                       content TEXT NOT NULL, tags TEXT NOT NULL, sig TEXT NOT NULL,
                       raw TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
                       UNIQUE(pubkey, kind, d_tag));
CREATE INDEX idx_events_feed ON events(kind, deleted, created_at DESC);
CREATE TABLE profiles (pubkey TEXT PRIMARY KEY, name TEXT, picture TEXT, about TEXT,
                       nip05 TEXT, raw TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE reserved_handles (handle TEXT PRIMARY KEY);  -- seeded: www api admin staff static mail blog help about root _dmarc
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);
-- Rate counters live in D1, NOT KV: KV free tier = only 1,000 writes/day (reserved for
-- sessions, gen bumps); D1 free tier = 100k writes/day. Login nonces are ALSO D1
-- (migrations/0003_login_nonces.sql — see the ratified P4 nonce-store addendum below).
CREATE VIRTUAL TABLE posts_fts USING fts5(title, summary, content, tokenize='porter unicode61');
-- REGULAR fts5 (stores its own text copy) — contentless/external-content variants can't do
-- the UPDATE/DELETE that edited/deleted posts need. rowid = events.rowid; the mirror service
-- maintains it (INSERT with explicit rowid on store, DELETE by rowid on replace/delete).
```
Replaceable semantics: on mirror, keep the event with the greater `created_at` per (pubkey, kind=30023, d_tag); ties broken by lower id. Kind 5 deletes set `deleted=1` on referenced events of the same pubkey.

**Key interfaces** (stable across phases — do not change signatures without orchestrator approval):
```ts
// src/nostr/event.ts
type NostrEvent = { id:string; pubkey:string; kind:number; created_at:number; tags:string[][]; content:string; sig:string };
verifyEvent(ev: NostrEvent): Promise<boolean>        // id recompute + schnorr verify (@noble/curves, @noble/hashes)
// src/nostr/nip19.ts
npubEncode/npubDecode, naddrEncode/naddrDecode
// src/nostr/relay.ts
fetchEvents(relays: string[], filter: object, timeoutMs: number): Promise<NostrEvent[]>  // WS pool, dedupe, EOSE/timeout
// src/services/mirror.ts
mirrorEvent(env, ev: NostrEvent): Promise<'stored'|'stale'|'invalid'>  // verify → replaceable upsert → FTS row → bump gen:<pubkey>
// src/services/users.ts
getUserByHandle(env, handle) / getUserByPubkey(env, pubkey) / claimHandle(env, pubkey, handle)
// src/markdown/index.ts
renderPost(md: string): string        // markdown-it + strict sanitizer; NO raw HTML passthrough
// src/middleware/tenant.ts sets c.var.site = {type:'main'} | {type:'blog', user, pubkey}
// sessions: cookie `sid` host-only on MAIN_HOST; KV `sess:<token>` → {pubkey, iat}, TTL 90d
// cache: Cache API key https://cache.internal/<host><path>?g=<gen>, gen from KV gen:<pubkey>, s-maxage=3600
```

**Fixtures** (`test/fixtures/`, generated once by `scripts/gen-fixtures.ts` with nostr-tools, committed): 3 test keypairs (alice, bob, mallory), signed kind 0 + kind 30023 events (valid set incl. markdown torture + XSS payloads in content), tampered variants (bad sig / bad id / wrong pubkey), a kind 5 delete, stale-vs-newer replaceable pairs. All tests use these — never generate keys at test time.

**Testing rules (every phase)**: implementer ships unit tests with the code; routes get `SELF.fetch` integration tests with Host overrides (`nostrbook.net`, `alice.nostrbook.net`, `unknown.nostrbook.net`, `nostrbook.net.evil.com`); rendered HTML/XML gets snapshot tests; `scripts/smoke.sh <base-url>` grows each phase and must pass; CI = typecheck + vitest.


## Addendum (P0, orchestrator-approved)
- `src/middleware/guard.ts` honors a client-supplied `X-Forwarded-Host` header as the Host override **only when `ENVIRONMENT === "development"`** (needed because `wrangler dev` rewrites the Host header). The committed `wrangler.jsonc` ships `ENVIRONMENT="production"`, so the override is dead in any stock deploy; dev gets it via `.dev.vars`. Do not widen this affordance.

## Addendum (P2→P3, orchestrator-approved)
- `MAX_MARKDOWN_LENGTH` is 32 KiB (DoS bound for markdown-it superlinear inputs). To keep public request CPU under the free-tier 10ms budget, **P3 must render at ingest**: migration `0002` adds `rendered TEXT` to `events` (or a sibling table); `mirrorEvent` runs renderPost+sanitize once at mirror time and stores the HTML; the tenant post view serves the stored HTML and must NOT call renderPost per request. Theme CSS is already pass-capped; P5 should additionally sanitize CSS at settings-save time.

## Addendum (P3 review fixes — orchestrator-RATIFIED)
- **Kind 5 ingestion**: the sync filters (cron refresh AND npub on-demand fetch) include kind 5, so author-published deletes from any Nostr client propagate to mirrored blogs. Without this, "Kind 5 deletes set deleted=1" was dead code — no ingestion path ever delivered a delete, and deleted posts stayed publicly visible forever. applyDelete remains strictly scoped to the signer's own rows.
- **NIP-09 delete horizon**: mirrorEvent checks stored kind-5 `a`-tags when storing a 30023 — a version whose created_at is <= a stored delete's created_at lands with `deleted=1`, so late-arriving intermediate edits cannot resurrect a deleted post.
- **`mirrorEvent(env, ev, opts?)`** gained an OPTIONAL `opts.bumpGen` flag (default `true` — the contract behavior is unchanged for existing callers). Multi-event ingest sessions (cron refresh, npub mirror) pass `false` and bump the gen once per touched pubkey per session: the KV free tier allows only 1,000 writes/day and a 100-event backfill must not cost 100 puts.
- **KV `gen:<pubkey>` values are opaque unique strings**, no longer counters. The cache middleware only ever compared equality; the counter's read-modify-write let two concurrent bumps collapse into one and pin stale pages until TTL.
- **`checkRateLimit` (services/ratelimit.ts) is implemented in P3** (was slated for P4): the unclaimed-npub mirror needs application-level global + per-IP daily caps (D1 `rate_limits`, single-statement fixed-window upsert) because the per-pubkey cooldown is bypassable by enumerating distinct npubs. P4 reuses it unchanged.
- **Cron watermark rules**: only VERIFIED events advance `sync.since`; far-future created_at (> now + 900s) events are skipped entirely; the watermark never advances over an unclosed relay window (full pages trigger `until`-paging, NIP-01 `limit` keeps the newest matches). Persisted via `json_set` touching only `$.sync.since`.

## Addendum (P4 review fixes — orchestrator-RATIFIED)
- **Handle regex TIGHTENED** to `^[a-z0-9][a-z0-9-]{0,29}[a-z0-9]$` (still 2–31 chars, but both ends must be alphanumeric). The P4-brief regex `^[a-z0-9][a-z0-9-]{1,30}$` admitted trailing-hyphen handles ("ab-") that the host guard's RFC-1035 `DNS_LABEL` 404s forever — claiming one would irrecoverably burn the key's single allowed handle on an unroutable subdomain. Claim validation, the dashboard form `pattern`, and the error copy all use the tightened shape.
- **Login events carry a `['relay','wss://<MAIN_HOST>']` service-binding tag** (NIP-42 style), REQUIRED and verified by POST `/login` (any URL whose hostname is MAIN_HOST is accepted; loopback hostnames additionally accepted in development only). Without it, a third-party site could proxy our challenge into its own NIP-07 signing flow and replay the victim's signature for session takeover. `public/js/login.js` also sets a human-readable `content` ("Log in to <host>") for signing-prompt transparency (not server-verified).
- **Challenge issuance budget**: per-IP challenge limit lowered 30 → 10/15min (login itself only permits 10/15min/IP), and a NEW global cap of 500 challenges/day (D1 `rate_limits` key `challenge:global`, same pattern as the P3 npub-mirror budget). Originally this guarded the 1,000-writes/day free-tier KV budget (every challenge was a KV put, every consumed nonce a KV delete); after the RATIFIED nonce→D1 move below, challenges no longer cost KV writes at all — both caps are RETAINED unchanged as a global abuse bound on `login_nonces` growth and D1 write burn.

## Addendum (P4 nonce store → D1 — orchestrator-RATIFIED)
- **Login nonces live in D1, not KV** (supersedes the P4 brief's "nonce in KV" and closes the "single-use is best-effort" residual previously documented here): migration `0003_login_nonces.sql` adds `CREATE TABLE login_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)` plus an index on `expires_at`.
- **Issue**: GET `/login/challenge` INSERTs the nonce with `expires_at = now + 300` (same 5-min TTL), after the unchanged per-IP and global-daily caps.
- **Consume (atomic, strictly single-use)**: POST `/login` runs `DELETE FROM login_nonces WHERE nonce = ?1 AND expires_at > ?2 RETURNING nonce` — exactly one concurrent caller gets the row; zero rows ⇒ 401 (expired/replayed/unknown). Consumption still happens BEFORE schnorr verification (a nonce is burned by its first presentation however the attempt ends), and the relay-tag/MAIN_HOST binding check still runs before the nonce lookup so misbound events cannot burn nonces. The KV get→delete replay window (~60s cross-colo) is gone.
- **Cleanup**: the challenge handler opportunistically sweeps `DELETE FROM login_nonces WHERE expires_at < now` (best-effort, batched with the insert) to bound table growth — D1 has no KV-style TTL.
- **KV surface shrinks**: nonces no longer touch KV at all. KV now carries only sessions (`sess:<token>`) and cache gen bumps (`gen:<pubkey>`); rate counters/cooldown windows stay in D1 (`rate_limits`) and the npub visit cooldown in the Cache API, as before.
- All other P4 auth behavior is byte-identical: 5-min nonce TTL, single-use, created_at ±10min window, login 10/15min/IP, challenge 10/15min/IP + 500/day global.

## Addendum (P5 review fixes — pending orchestrator ratification)
- **NEW migration `0004_delete_horizons.sql` (SCHEMA CHANGE)**: `CREATE TABLE delete_horizons (address TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)`. The events table holds only one kind-5 marker per `(pubkey, 5, '')` slot, so each new delete overwrote the previous marker and its a-tags — `coveredByDeleteHorizon` (which scanned stored kind-5 rows) then lost the earlier delete's horizon, and a late-arriving intermediate edit could publicly RESURRECT a serially-deleted post. `applyDelete` now upserts `MAX(deleted_at)` per a-tag address into this table (inside its atomic batch), and `coveredByDeleteHorizon` consults the table by address — horizons persist regardless of marker churn. The P5 editor makes serial deletes routine, so this was routine exposure, not theoretical. Test helper `resetMirrorState` clears the new table.
- **`/dashboard/settings` rate limit (was UNGATED)**: gated `settings:pk:<pubkey>` at 20/5min via `rateLimitAllows`, before any KV/D1 write. Sessions are permissionless, and every save did an unconditional `bumpGen` (KV put); a loop could exhaust the platform-wide 1,000-writes/day KV budget and break gen-bump cache invalidation AND new-login session creation for ALL tenants. Additionally, `bumpGen` now fires **only when css or about actually changed** vs the stored settings — a no-op save (or a relays-only change, which does not affect the rendered blog) costs zero KV writes.
- **Absolute per-pubkey post cap on `POST /api/mirror`**: a NEW kind-30023 slot (a d-tag not already stored) is refused with 403 once the key holds `MAX_POSTS_PER_PUBKEY = 1000` live posts. Edits (existing d-tag) and deletes are never blocked. The per-window `MIRROR_MAX` throttles bursts but bounded nothing absolute; distinct d-tags each create new rows in the shared D1. Enforced in the editor route ONLY — cron/npub ingestion via `mirrorEvent` is uncapped so a user's real backlog still mirrors.
- **Blocked keys cannot write**: `POST /api/mirror` and `POST /dashboard/settings` now look up the user and return 403 when `blocked` (mirroring `/dashboard/claim`). Previously a blocked pubkey with a live session kept storing posts/deletes/settings (D1/FTS rows, gen bumps) that would resurface on unblock.
- **Content-Length required on the JSON write endpoints**: `POST /api/mirror` and `POST /dashboard/preview` now reject a missing/empty Content-Length with 413. `Number(undefined ?? "0") === 0` previously passed the pre-parse body cap, letting a chunked/CL-less body buffer up to the platform limit before the downstream field caps applied. Browsers always send Content-Length for a `fetch` with a string body, so the editor is unaffected.
- **Cron sync uses the user's configured relays**: `refreshUser` merges `settings.relays` (ahead of the `RELAYS` default list, deduped) so a user whose posts live only on their own relays is actually mirrored — matching the documented "editor-side broadcast + sync" purpose of the setting.
- **Dashboard `about` setting now renders on the blog**: `blogCtx` reads `settings.about` and `BlogLayout` prefers it over the kind-0 profile's about when non-empty. The setting was previously write-only (stored + round-tripped in the form but never displayed).
- **Editor edit page moved off the colliding path**: `GET /dashboard/posts/:slug` → `GET /dashboard/editor?slug=<d-tag>` (dashboard Edit links updated). `/dashboard/posts/new` (literal) shadowed `:slug`, making a post whose d-tag is exactly `new` (which slugify mints from the title "New", and relay-mirrored posts may carry) uneditable/undeletable; d-tags `.`/`..` were also path-normalized by browsers. The query param handles all hostile d-tags uniformly.
- **Protective leading newline in the editor content and dashboard CSS textareas** (`{"\n" + value}`): the HTML parser eats exactly one newline after `<textarea>`, so content/CSS that itself starts with a newline round-trips unchanged instead of silently losing a leading `\n` (which for a post would mint a different event id on republish).
