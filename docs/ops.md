# nbread.lol operations (P7)

Hardening + launch reference: security headers, the full per-endpoint
rate-limit/cache inventory, WAF dashboard settings, free-tier incident notes,
the abuse-blocklist admin, and the deploy-gates runbook. Companion to
`docs/setup.md` (one-time zone/DNS/resource setup).

## 1. Security headers

Applied by `src/middleware/headers.ts`, registered FIRST on the outer app so
every Worker response is stamped — guard 404s (unknown/spoofed hosts), tenant
404s, cache hits, redirects, XML feeds, JSON APIs. Two host classes:

| Class | Applies to | CSP | Extra |
| ----- | ---------- | --- | ----- |
| **Blog** | `<handle>.nbread.lol` (all paths) AND apex `/npub1…` views | `default-src 'none'; img-src * data:; style-src 'self' 'unsafe-inline'; media-src *; base-uri 'none'; form-action 'none'` | no XFO (embeddable **by design** — see notes) |
| **Apex** | everything else on `nbread.lol` (+ unknown-host 404s) | `default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src * data:; media-src *; connect-src 'self' wss:; frame-src https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` | `X-Frame-Options: DENY` |

Both classes always send `X-Content-Type-Options: nosniff` and
`Referrer-Policy: strict-origin-when-cross-origin`.

Notes:

- **Blog pages are JS-free by policy** — no `script-src` at all, so
  `default-src 'none'` blocks every script. Enforced by tests
  (`test/integration/headers.spec.ts` asserts no `<script` in blog markup).
- Blog `style-src` carries `'self'` (the shared `/css/style.css` base
  stylesheet) + `'unsafe-inline'` (the sanitized per-blog theme `<style>`).
  `'self'` is safe because the same-origin namespace is fully
  platform-controlled: `public/` holds only first-party files and every
  **Worker** response carries nosniff with a non-CSS Content-Type, so no
  attacker-influenced same-origin bytes are loadable as a stylesheet.
- Blog `base-uri 'none'; form-action 'none'` (neither falls back to
  `default-src`): blog pages render hostile relay content, and the sanitizer
  (which drops `<base>`/`<form>`) must not be the only line of defense
  against `<base href>` link rewriting / `<form action>` input harvesting.
  Blog markup ships neither element, so the pins cost nothing.
- **Blogs are frameable by design** (no XFO / `frame-ancestors` on the blog
  class; the contract mandates XFO on the apex only): blog pages are JS-free,
  read-only, carry no session (`sid` is host-only on the apex) and no
  state-changing UI, so framing yields at most link-click redressing —
  accepted in exchange for embeddability.
- Apex needs: same-origin JS (`login.js`, `editor.js`), the **Turnstile**
  script + iframe (`challenges.cloudflare.com` — the only third-party origin
  in the product), `connect-src 'self' wss:` (login/preview/mirror fetches +
  the editor's client-side relay broadcast to arbitrary user relays), and
  `img-src * data:` / `media-src *` so the editor preview renders posts with
  blog fidelity.
- **Cached responses**: the Cache API stores the body from the miss, but the
  headers middleware re-stamps policy on every pass — hits and misses carry
  identical headers (tested for the blog gen cache and the /discover page
  cache).
- **Static assets** (`public/` → `/css/*`, `/js/*`) are served by the Static
  Assets layer *before* the Worker runs and do not carry these headers. They
  are subresources with correct Content-Types, not documents; CSP/XFO are
  document-level policies.

## 2. Endpoint inventory: rate limits, caches, budget bounds

All limiters are D1 fixed windows (`rate_limits`, single upsert per check —
**zero KV writes**) via `checkRateLimit`/`rateLimitAllows`, and **fail
closed** (a D1 error denies). Denied requests still count. Sessions are
permissionless (anyone with a keypair can mint one), so per-pubkey limits are
abuse bounds, not politeness.

### Apex (nbread.lol)

| Endpoint | Limiter (key → max/window) | Cache | Per-request cost / bound |
| -------- | -------------------------- | ----- | ------------------------ |
| `GET /` | — | — | pure SSR, no storage I/O (WAF backstop) |
| `GET /healthz` | — | — | trivial JSON |
| `GET /login` | — | — | pure SSR |
| `GET /login/challenge` | `challenge:ip` → 10/15min, `challenge:global` → 500/day | `no-store` | D1 nonce insert + expired sweep |
| `POST /login` | `login:ip` → 10/15min | `no-store` | atomic nonce consume, schnorr verify, 1 KV write (session) on success |
| `POST /logout` | `logout:ip` → 30/15min *(P7)* | — | 1 KV **write** (delete) — was the last unmetered KV-write path |
| `GET /dashboard` | session + `dash:pk` → 60/5min *(P7)* | — | ≤100-row post list per render |
| `GET /dashboard/posts/new`, `GET /dashboard/editor` | session | — | 1–2 row reads |
| `POST /dashboard/claim` | `claim:ip` → 3/h + Turnstile + blocked gate | — | reserved-handle read + upsert |
| `POST /dashboard/settings` | `settings:pk` → 20/5min + blocked gate | — | D1 write; KV gen bump **only when css/about changed** |
| `POST /dashboard/preview` | `preview:pk` → 60/5min + `Content-Length` ≤ 400 KB (required) + blocked gate *(P7)* | `no-store` | renderPost on the request path (authed only, budgeted) |
| `POST /api/mirror` | `mirror:pk` → 30/5min + `Content-Length` ≤ 2 MB (required) + `MAX_POSTS_PER_PUBKEY` 1000 + blocked gate | — | schnorr + render-at-ingest + D1/FTS writes + 1 KV gen bump |
| `GET /discover` | `discover:ip` → 60/min **on cache miss only** | Cache API per clamped page (≤50 keys), TTL 300s, 200s only | miss: joined feed query (≤ ~1k rows at page 50); hit: zero D1/KV |
| `GET /search` | `search:ip` → 30/min (non-empty `q` only) | — | FTS MATCH (sanitized) + join, LIMIT 20 |
| `GET /npub1…` (+ `/rss.xml`, `/atom.xml`, `/:slug`) | `npub:ip` → 60/min *(P7)*; relay mirror sessions additionally: per-pubkey cooldown 300s (Cache API marker) + `npub-mirror:ip` → 30/day + `npub-mirror:global` → 500/day, ≤10 verifications/session | — | ≤100-row post list per view (the P7 limiter closes the unmetered-read gap) |
| `GET /.well-known/nostr.json` | — | `max-age=300` | 1-row indexed read (WAF backstop); blocked/unknown → `{"names":{}}` |
| `GET /admin` | ADMIN_PUBKEY gate (404 otherwise) | — | 1 KV session read + ≤200-row blocked list |
| `POST /admin/block`, `POST /admin/unblock` | gate + `admin:pk` → 30/5min *(P7)* | — | 1 D1 write + 1 KV gen bump |

CSRF (Origin / Sec-Fetch-Site same-origin proof) covers **every** unsafe
method on the apex, `/admin` and `/api` included.

### Blog subdomains (`<handle>.nbread.lol`)

| Endpoint | Limiter | Cache | Per-request cost |
| -------- | ------- | ----- | ---------------- |
| `GET /`, `/:slug`, `/rss.xml`, `/atom.xml`, `/sitemap.xml`, `/robots.txt` | — | Cache API `https://cache.internal/<host><path>?g=<gen>`, `s-maxage=3600`, 200s only | every request: 1 KV read (gen) + 1-row tenant lookup; misses: ≤100-row reads; render is ingest-time HTML (never renderPost) |
| anything else / non-GET | — | — | rendered 404 |

### Cron (`*/15 * * * *`)

Bounded by the relay list (defaults + per-user `settings.relays`, deduped),
the verified-only `sync.since` watermark, and one gen bump per touched pubkey
per run.

### KV write classes (the scarce resource: 1,000 writes/day)

1. **Session create** — `POST /login` (capped 10/15min/IP; key minting itself
   bounded by the 500/day global challenge cap).
2. **Session delete** — `POST /logout` (capped 30/15min/IP).
3. **Gen bumps** — mirror store (editor + cron + npub sessions, all capped),
   settings change (only on real css/about change), admin block/unblock
   (admin-only, 30/5min).

Nothing else writes KV. P7 added **no new KV write classes** — admin bumps
are ordinary gen bumps.

## 3. WAF setup (Cloudflare dashboard, zone `nbread.lol`)

Application-level limits above bound *single-source* abuse; the WAF is the
*distributed/volumetric* backstop (and keeps scanner noise off the Worker
entirely — every blocked request saves Worker invocations and D1 writes).
Rate-limiting rules and custom rules are both free-plan features, **but the
free plan gates which expression fields/functions are available, and the
exact set varies by account — verify the expressions below against the live
zone at Gate B step 7 and fall back as documented if the dashboard rejects
them.** Configure once after Gate B:

### 3a. Zone rate-limiting rule (Security → WAF → Rate limiting rules)

- **Rule name**: `global-per-ip-throttle`
- **If incoming requests match**: preferred expression
  `(http.host eq "nbread.lol") or (http.host wildcard "*.nbread.lol")`.
  **Free-plan caveat**: rate-limiting rule expressions restrict the field set
  (`http.host` and the `wildcard` operator are plan-gated on some accounts).
  If the dashboard rejects it, use the guaranteed-configurable fallback: the
  zone serves ONLY this Worker, so an all-traffic match is equivalent — use
  a URI-path match (e.g. `(http.request.uri.path wildcard "*")`) or the
  dashboard's default "all incoming requests" scope. Do NOT skip the rule or
  improvise a narrower scope: the budget math in §2/§4 leans on this
  backstop.
- **With the same characteristics**: IP (free plan default)
- **When rate exceeds**: **60 requests / 10 seconds** (the free plan fixes
  the counting period at 10s). Zone requests per page view are small — the
  document plus a couple of same-origin assets; post images/media load from
  external origins — so 6 rps sustained is far above human browsing. Shared
  NAT (CGNAT) bursts may occasionally trip it; mitigation lasts only 10s.
- **Then take action**: **Block**
- **For duration**: 10 seconds (free-plan mitigation timeout)
- **Why 60, and when to tighten**: the WAF is the ONLY control over the
  per-request baseline reads that cannot be metered app-side without
  spending scarcer D1 writes — 1 KV read per apex request bearing a
  well-shaped `sid` cookie (session resolution), 1 KV gen read per
  blog-subdomain request, 1–2 D1 rows per tenant / `nostr.json` lookup.
  Even at 60/10s one IP can sustain ~518k req/day, which still out-runs the
  100k/day KV-read budget — the rule bounds the burn *rate*; it does not
  make exhaustion impossible. **Pre-planned escalation**: on KV-read or
  D1-rows-read exhaustion symptoms (§4), tighten the threshold to
  **10 requests / 10 seconds** until the offender is identified and
  WAF-blocked (by IP/ASN), then restore.

### 3b. Scanner-path block (Security → WAF → Custom rules)

- **Rule name**: `scanner-paths-block`
- **Expression**:

  ```
  (ends_with(http.request.uri.path, ".php"))
  or (starts_with(http.request.uri.path, "/wp-"))
  or (http.request.uri.path contains "/.env")
  ```

- **Action**: **Block**
- **Free-plan caveat**: `ends_with()`/`starts_with()` availability is
  plan-gated on some accounts. If the expression editor rejects them, the
  `contains` operator (available on all plans) is an acceptable, slightly
  broader fallback:

  ```
  (http.request.uri.path contains ".php")
  or (http.request.uri.path contains "/wp-")
  or (http.request.uri.path contains "/.env")
  ```

Known trade-off: a blog post whose d-tag slug ends in `.php` or starts with
`wp-` (or, under the fallback, merely *contains* those strings) becomes
unreachable at the edge. Acceptable; authors control their slugs and the
editor's slugify never mints such shapes.

## 4. Incident notes: free-tier budget exhaustion

| Budget | Daily quota | Exhaustion symptoms | Response |
| ------ | ----------- | ------------------- | -------- |
| **KV writes** | 1,000 | New logins 500 (session put fails); `POST /api/mirror` / settings saves error after the D1 write (gen bump throws) → blogs serve **stale cached pages** until TTL; admin block can't invalidate caches (block still 404s live traffic — the tenant check precedes the cache) | `wrangler tail` to find the writer; block the offending key via `/admin`; verify the write classes above — anything else writing KV is a bug. Quota resets daily (UTC) |
| **KV reads** | 100,000 | Session resolution fails → authed pages 500 (`/admin` included); blog-page gen reads are try/caught → blogs **degrade to uncached serving** (D1 load rises but pages stay up). **A single IP inside the WAF allowance can reach this** — every apex request with a well-shaped `sid` cookie costs 1 KV read; the app cannot meter it without D1 writes (§3a) | WAF-block the offending IP; apply the §3a pre-planned escalation (tighten to 10/10s); quota resets daily (UTC) |
| **D1 rows read** | 5,000,000 | Feed/search queries error; **every blog request 500s — cache hits included** (the tenant lookup is an unguarded D1 read that runs BEFORE the blog cache; deliberate — failing open there would serve blocked users during outages); `/discover` **cache hits keep serving**; `/search` shows its distinct 503 "temporarily unavailable" page | Identify the hot key/IP via `rate_limits` (`SELECT * FROM rate_limits ORDER BY count DESC LIMIT 20`); WAF-block; apply the §3a escalation. Cached + rate-limited paths (P6/P7) close the *bulk*-read routes, but the uncached 1–2-row paths (tenant lookups, slug-404 probes, `nostr.json`) let one or two IPs inside the WAF allowance grind through this budget |
| **D1 rows written** | 100,000 | **All limiters fail CLOSED** → 429s on challenge/login/discover-miss/search/npub/mirror; nonce issuance fails → logins stop | This is the deliberate fail-safe posture: the platform read paths (cached blogs, discover hits) keep serving. WAF-block the source; wait for reset |
| **Cache API** | best-effort | All cache layers degrade to uncached (every layer is try/caught) → D1/CPU load rises, correctness unchanged | Watch D1 budgets (above); usually transient |
| **Worker requests** | 100,000/day | Cloudflare serves errors once exceeded | WAF rate rule is the main dial; scanner-path block cuts the noise floor |

Observability is enabled in `wrangler.jsonc`; `wrangler tail` gives live
logs (rate-limit denials log their key via `console.error` on D1 failures
only — denials themselves are silent 4xxs by design).

## 5. Abuse blocklist admin

- **Enable**: `wrangler secret put ADMIN_PUBKEY` — hex pubkey or `npub1…` of
  the ONE admin identity. Unset/empty/malformed ⇒ every `/admin` route 404s
  (fail closed). There is no dashboard link to `/admin`; it is deliberately
  undiscoverable.
- **Use**: sign in at `/login` with the admin key (ordinary NIP-07 session),
  then visit `/admin`. Block/unblock by **handle**, **npub**, or **hex
  pubkey** (npub/hex work for keys that never claimed — pre-emptive blocks
  create the users row blocked, which also refuses any later claim).
- **Effect of a block** (all covered by `test/integration/admin.spec.ts`):
  - blog subdomain 404s immediately (tenant check runs before the cache) and
    the gen bump strands every cached page;
  - apex `/npub1…` views 404;
  - posts drop from `/discover` (cached pages age out ≤300s) and `/search`;
  - **NIP-05 policy (decided)**: the handle is dropped from
    `/.well-known/nostr.json` (`{"names":{}}`, indistinguishable from
    unknown) — the platform stops vouching for the identity the moment the
    block lands;
  - writes refuse: `POST /api/mirror`, `/dashboard/settings`,
    `/dashboard/claim` → 403;
  - `POST /dashboard/preview` refuses too (403) — the one endpoint allowed
    to run renderPost on the request path; blocked identities must not spend
    request-path CPU. The dashboard GET pages deliberately STAY reachable so
    a blocked user can see the state of their account (reads are cheap and
    rate-limited; nothing persists).
- **Unblock** restores everything (fresh gen bump ⇒ no stale pre-block
  cache).
- Admin actions are CSRF-protected (same-origin proof) and rate-limited
  (`admin:pk` 30/5min). Non-admin sessions and anonymous callers see plain
  404s — no probing signal.

## 6. Deploy-gates runbook

**Do not deploy until the orchestrator executes these gates.** Preconditions
for both gates: CI green (typecheck + vitest + `wrangler deploy --dry-run`)
on the release commit, and `bash scripts/smoke.sh local` green.

### Secrets & bindings checklist (once per account)

```sh
wrangler d1 create nbread          # paste database_id into wrangler.jsonc
wrangler kv namespace create KV       # paste id into wrangler.jsonc
wrangler d1 migrations apply nbread --remote

wrangler secret put TURNSTILE_SECRET_KEY   # from the Turnstile widget (see below)
wrangler secret put ADMIN_PUBKEY           # OPTIONAL — omit to launch with /admin disabled
```

- Create the Turnstile widget (dashboard → Turnstile) for `nbread.lol`
  **and add the workers.dev preview hostname** (e.g.
  `nbread.<account>.workers.dev`) to the widget's hostnames so Gate A can
  exercise the claim flow. Put the site key in `wrangler.jsonc`
  `vars.TURNSTILE_SITE_KEY`.
- `vars.ENVIRONMENT` stays `"production"` in the committed config (the
  dev-only X-Forwarded-Host override must never ship enabled).

### Gate A — workers.dev preview

The zone `nbread.lol` must already exist on the account (add it per
`docs/setup.md` §1 — routes can attach while DNS still points elsewhere;
user traffic is unaffected because no DNS records exist yet).

```sh
# Deploy with MAIN_HOST overridden to the preview host so the host guard
# treats workers.dev as the apex (the committed var stays nbread.lol):
npx wrangler deploy --var MAIN_HOST:nbread.<account>.workers.dev

# Smoke vs the preview URL (subdomain checks auto-skip on workers.dev):
bash scripts/smoke.sh https://nbread.<account>.workers.dev
```

Gate A passes when: CI is green, preview smoke is green, and a manual
login → claim → publish loop works on the preview (needs a NIP-07 extension;
see the manual-check notes at the bottom of `scripts/smoke.sh`).

### Gate B — nbread.lol live

1. **DNS** (per `docs/setup.md` §2): apex `A @ 192.0.2.1` **Proxied** +
   wildcard `CNAME * nbread.lol` **Proxied**. SSL/TLS **Full (strict)**;
   confirm Universal SSL covers `nbread.lol` + `*.nbread.lol`.
   Then, under SSL/TLS → **Edge Certificates**: enable **Always Use HTTPS**
   and **HSTS** with `max-age` ≥ 6 months (15552000). Sessions are Secure
   host-only cookies on the apex; without zone HSTS a first-visit `http://`
   navigation is interceptable before the 301. Hold off
   `includeSubDomains`/preload until tenant subdomains are confirmed stable
   on TLS (a preloaded broken wildcard is unrecoverable for months).
2. **Deploy the committed config** (restores `MAIN_HOST=nbread.lol`):

   ```sh
   npx wrangler deploy
   ```

3. Verify both routes (`nbread.lol/*`, `*.nbread.lol/*`) appear under
   the zone's Workers Routes page and the cron shows under the Worker's
   Triggers tab.
4. **Smoke vs prod** (includes subdomain + header checks):

   ```sh
   bash scripts/smoke.sh https://nbread.lol
   ```

5. **Observe the cron**: `npx wrangler tail --format=pretty` across one
   15-minute boundary; confirm a `scheduled` execution logs.
6. **Acceptance**: claim a test blog with a real NIP-07 key (login → claim →
   publish via the editor, or publish a NIP-23 post from any Nostr client
   and wait ≤15 min for the cron) and confirm
   `https://<handle>.nbread.lol/` renders the relay content, RSS
   validates, and `https://nbread.lol/.well-known/nostr.json?name=<handle>`
   answers.
7. **WAF**: configure §3 (rate rule + scanner-path block). The preferred
   expressions use fields/functions whose free-plan availability varies by
   account (`http.host`, `wildcard`, `ends_with`/`starts_with`) — if the
   dashboard rejects them, apply the documented fallbacks in §3a/§3b rather
   than skipping the rule.

Rollback: `wrangler deployments list` + `wrangler rollback` restore the
previous Worker version; DNS records can stay (the guard 404s anything it
does not recognize).

## 7. Vendor crypto bundle

`public/js/vendor/nostr-crypto.js` is generated from
`scripts/vendor/crypto-entry.js` by `npm run build:vendor` (esbuild,
devDependency only — deploy never builds) and committed unminified. Never
edit the artifact by hand: edit the entry, rebuild, commit both. CI rebuilds
and fails on any drift between the entry and the committed bundle.
