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

## Addendum (P5 review fixes — orchestrator-RATIFIED 2026-07-12)
Ratified in full: the `delete_horizons` schema change (migration 0004), the settings rate limit + conditional bumpGen, the `MAX_POSTS_PER_PUBKEY = 1000` cap, the blocked-key write gate, the Content-Length requirement, the cron relay-merge, the `about` render, the editor edit-route move, and the textarea leading-newline guard. Constants (`SETTINGS_MAX = 20/5min`, `MAX_POSTS_PER_PUBKEY = 1000`) are accepted defaults and may be tuned later.
- **NEW migration `0004_delete_horizons.sql` (SCHEMA CHANGE)**: `CREATE TABLE delete_horizons (address TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)`. The events table holds only one kind-5 marker per `(pubkey, 5, '')` slot, so each new delete overwrote the previous marker and its a-tags — `coveredByDeleteHorizon` (which scanned stored kind-5 rows) then lost the earlier delete's horizon, and a late-arriving intermediate edit could publicly RESURRECT a serially-deleted post. `applyDelete` now upserts `MAX(deleted_at)` per a-tag address into this table (inside its atomic batch), and `coveredByDeleteHorizon` consults the table by address — horizons persist regardless of marker churn. The P5 editor makes serial deletes routine, so this was routine exposure, not theoretical. Test helper `resetMirrorState` clears the new table.
- **`/dashboard/settings` rate limit (was UNGATED)**: gated `settings:pk:<pubkey>` at 20/5min via `rateLimitAllows`, before any KV/D1 write. Sessions are permissionless, and every save did an unconditional `bumpGen` (KV put); a loop could exhaust the platform-wide 1,000-writes/day KV budget and break gen-bump cache invalidation AND new-login session creation for ALL tenants. Additionally, `bumpGen` now fires **only when css or about actually changed** vs the stored settings — a no-op save (or a relays-only change, which does not affect the rendered blog) costs zero KV writes.
- **Absolute per-pubkey post cap on `POST /api/mirror`**: a NEW kind-30023 slot (a d-tag not already stored) is refused with 403 once the key holds `MAX_POSTS_PER_PUBKEY = 1000` live posts. Edits (existing d-tag) and deletes are never blocked. The per-window `MIRROR_MAX` throttles bursts but bounded nothing absolute; distinct d-tags each create new rows in the shared D1. Enforced in the editor route ONLY — cron/npub ingestion via `mirrorEvent` is uncapped so a user's real backlog still mirrors.
- **Blocked keys cannot write**: `POST /api/mirror` and `POST /dashboard/settings` now look up the user and return 403 when `blocked` (mirroring `/dashboard/claim`). Previously a blocked pubkey with a live session kept storing posts/deletes/settings (D1/FTS rows, gen bumps) that would resurface on unblock.
- **Content-Length required on the JSON write endpoints**: `POST /api/mirror` and `POST /dashboard/preview` now reject a missing/empty Content-Length with 413. `Number(undefined ?? "0") === 0` previously passed the pre-parse body cap, letting a chunked/CL-less body buffer up to the platform limit before the downstream field caps applied. Browsers always send Content-Length for a `fetch` with a string body, so the editor is unaffected.
- **Cron sync uses the user's configured relays**: `refreshUser` merges `settings.relays` (ahead of the `RELAYS` default list, deduped) so a user whose posts live only on their own relays is actually mirrored — matching the documented "editor-side broadcast + sync" purpose of the setting.
- **Dashboard `about` setting now renders on the blog**: `blogCtx` reads `settings.about` and `BlogLayout` prefers it over the kind-0 profile's about when non-empty. The setting was previously write-only (stored + round-tripped in the form but never displayed).
- **Editor edit page moved off the colliding path**: `GET /dashboard/posts/:slug` → `GET /dashboard/editor?slug=<d-tag>` (dashboard Edit links updated). `/dashboard/posts/new` (literal) shadowed `:slug`, making a post whose d-tag is exactly `new` (which slugify mints from the title "New", and relay-mirrored posts may carry) uneditable/undeletable; d-tags `.`/`..` were also path-normalized by browsers. The query param handles all hostile d-tags uniformly.
- **Protective leading newline in the editor content and dashboard CSS textareas** (`{"\n" + value}`): the HTML parser eats exactly one newline after `<textarea>`, so content/CSS that itself starts with a newline round-trips unchanged instead of silently losing a leading `\n` (which for a post would mint a different event id on republish).

## Addendum (P6 review fixes — orchestrator-RATIFIED 2026-07-12)
- **`/discover` is really cached and rate limited (was neither)**: a Worker-GENERATED response is never stored in Cloudflare's edge cache merely by carrying `s-maxage` — the original P6 implementation therefore ran the joined D1 feed query on EVERY request, and `?page=50` costs ~1,000 rows_read (OFFSET 980 + join probes), letting a single unauthenticated client burn the platform-wide 5M rows_read/day D1 budget in minutes. Two layers now protect it: (1) a **Cache API entry per page** — key `https://cache.internal/discover?page=<clamped 1..50>` (a SECOND key namespace beside the per-tenant `<host><path>?g=<gen>` contract keys, like the P3 npub-cooldown markers), TTL `DISCOVER_CACHE_SECONDS = 300`, keyed on the CLAMPED page only so cache-buster query params cannot force a miss; hit/miss exposed via `X-Nostrbook-Cache`; only 200s are cached; (2) a **per-IP rate limit** `discover:ip:<ip>` at `DISCOVER_RATE_MAX = 60`/60s via the existing D1 `rate_limits` (zero KV writes), checked ONLY on cache misses, denying with a friendly 429 page (never 5xx). Cross-tenant feed staleness is bounded by the 300s TTL (there is deliberately no gen-bump invalidation — a cross-tenant page cannot key on one pubkey's gen).
- **Slim feed projection (public-path CPU/IO)**: `listRecentClaimedPosts` and `searchPosts` no longer `SELECT e.*` (which hauled content+rendered+raw — up to ~100KiB/row — through D1 per request); they share `FEED_SELECT_COLUMNS` (id, pubkey, kind, d_tag, created_at, tags, handle) with `content` truncated to `FEED_CONTENT_PREFIX_CHARS = 2048` chars, enough for postMeta's first-heading title fallback. Behavior change only for pathological posts: a TITLE-TAG-LESS post whose first markdown heading sits beyond 2,048 chars lists as "Untitled" in discover/search (its own blog pages still parse full content).
- **`searchPosts(env, query, limit?) → Promise<FeedRow[] | null>`** (not in the key-interfaces list; recorded for visibility, supersedes the implementer-report note): `FeedRow` is the slim projection above plus the author's claimed `handle` (needed for cross-tenant URLs; the users JOIN makes claimed+non-blocked scoping structural). **`null` means a real backend failure** (D1 outage/schema drift — hostile input can never reach the catch, the sanitizer's output shape is unit-proven valid MATCH) and `GET /search` renders a distinct 503 "temporarily unavailable" page instead of silently masquerading outages as empty result sets. `[]` still means "no results" (including nothing-searchable queries). The P6 brief's suggested name `search` was not adopted; the pre-existing `searchPosts` stub name/parameter list was kept.
- **P6 CSS scoped to P6 surfaces**: the new `.post-item`/`.post-summary`/`.post-date`/`.empty` rules are scoped under `.feed-list`/`.discover`/`.search` so tenant blog pages and the dashboard (which reuse those class names) keep the exact P5 base styles that per-user theme CSS composes against.

## Addendum (P7 review fixes — pending orchestrator ratification)
- **Blog-class CSP (final delivered string)**: `default-src 'none'; img-src * data:; style-src 'self' 'unsafe-inline'; media-src *; base-uri 'none'; form-action 'none'`. Two bundled divergences from the P7 brief string: (1) **style-src gains `'self'`** — every blog page loads the shared base stylesheet `/css/style.css` via same-origin `<link>`; the brief-literal CSP would ship every blog unstyled at launch. `'self'` admits no attacker-controlled bytes: `public/` holds only first-party files (no user-supplied content is ever served from `/css` or `/js`) and every Worker response carries nosniff with a non-CSS Content-Type. (2) **`base-uri 'none'; form-action 'none'` appended** (review fix): neither directive falls back to `default-src`, blog pages are the ones rendering hostile relay content, and the sanitizer (which drops `<base>`/`<form>`) must not be the only line of defense against `<base href>` link rewriting / `<form action>` input harvesting. Blog markup ships neither element. `test/integration/headers.spec.ts` and `scripts/smoke.sh` assert the delivered string.
- **New OPTIONAL secret `ADMIN_PUBKEY`** (hex or `npub1…`; a wrangler secret, not a committed var; typed via `src/env.d.ts` declaration merging) gates the P7 `/admin` blocklist surface. Unset/empty/malformed ⇒ every `/admin` route 404s (fail closed); non-admin and anonymous callers get an indistinguishable 404. Additive to the contract bindings list — no existing signature changed. `wrangler.jsonc` additionally sets `workers_dev: true` for the Gate A preview origin (harmless in prod: the host guard 404s any Host that is not MAIN_HOST or a single-label subdomain of it).
- **Three new D1 `rate_limits` keys** (P7 rate-limit review; same fixed-window pattern, zero KV writes, fail closed): `npub:ip` 60/min on all apex `/npub1…` views (closes the unmetered ~100-rows_read/request public path), `logout:ip` 30/15min on `POST /logout` (a well-shaped bogus cookie previously cost an unmetered KV delete — a write op), `dash:pk` 60/5min on `GET /dashboard` (heaviest permissionless-session read). These paths now 429 where they previously never rate-limited.
- **Pre-emptive admin block of a never-claimed key** upserts a `users` row with `handle=NULL, blocked=1, claimed_at=<block timestamp>` — `claimed_at` no longer strictly means "when the handle was claimed" for such rows. No current reader interprets `claimed_at` for handle-NULL rows (feed/search/cron all key on `handle IS NOT NULL`); `claimHandle`'s `ON CONFLICT … WHERE handle IS NULL` path overwrites the synthetic value on a post-unblock claim. Recorded for visibility, not a schema change.
- **NIP-05 policy for blocked users (DECIDED)**: blocked handles are dropped from `/.well-known/nostr.json` entirely (`{"names":{}}`, indistinguishable from unknown). The wellknown check pre-dates P7; P7 elevates it to ratified policy with integration coverage (block → drop, unblock → restore).
- **Blocked keys also lose the request-path renderPost surface** (review fix): `POST /dashboard/preview` returns 403 for blocked pubkeys, joining the P5 write gates (`/api/mirror`, `/dashboard/settings`, `/dashboard/claim`). The dashboard GET pages deliberately stay reachable so a blocked user can see the state of their account (reads are cheap, rate-limited, and persist nothing).
- **Admin target resolution fallback** (review fix): a block/unblock target that starts with `npub1` but fails bech32 decode falls through to the handle lookup when it matches `HANDLE_REGEX` (≤31 chars; real npubs are 63 and can never match) — handles like `npub1spam` are legitimately claimable and must resolve on the primary abuse-response path instead of dead-ending in a decode error.
- **Blog pages are embeddable BY DESIGN** (no `X-Frame-Options`/`frame-ancestors` on the blog class, matching the contract's apex-only XFO mandate): blog pages are JS-free, read-only, carry no session on tenant hosts, and have no state-changing UI — framing yields at most link-click redressing. Accepted posture, documented in `docs/ops.md` §1.
