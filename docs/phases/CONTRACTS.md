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
-- sessions, login nonces, gen bumps); D1 free tier = 100k writes/day.
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
