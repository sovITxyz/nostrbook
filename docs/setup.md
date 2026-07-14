# nbread.lol — zone / DNS / infrastructure setup checklist

Manual, one-time steps done in the Cloudflare dashboard + wrangler CLI. Nothing
here is needed for local dev or CI; local D1/KV are simulated.

## 1. Zone

- [ ] Add the `nbread.lol` zone to the Cloudflare account (free plan).
- [ ] Point the registrar's nameservers at the two Cloudflare-assigned NS hosts.
- [ ] Wait for the zone to become **Active**.
- [ ] SSL/TLS mode: **Full (strict)**.
- [ ] Edge Certificates: confirm the Universal SSL cert covers `nbread.lol`
      and `*.nbread.lol` (universal certs include the first-level wildcard).
- [ ] Edge Certificates (at Gate B, once TLS is confirmed working): enable
      **Always Use HTTPS** + **HSTS** (`max-age` ≥ 6 months; hold
      `includeSubDomains`/preload until tenant subdomains are confirmed stable
      on TLS — see `docs/ops.md` §6 Gate B step 1).

## 2. DNS records

| Type  | Name | Content                  | Proxy   |
| ----- | ---- | ------------------------ | ------- |
| A     | `@`  | `192.0.2.1` (dummy)      | Proxied |
| CNAME | `*`  | `nbread.lol`          | Proxied |

- The apex A record is a placeholder — the Worker route intercepts all traffic;
  any proxied record works (or use a Workers **custom domain** on the apex
  instead, which manages the record automatically).
- The wildcard CNAME must be **proxied** (orange cloud) or subdomains bypass
  the Worker. Free plans proxy first-level wildcards fine.
- [ ] Optional: `_dmarc` TXT + SPF once outbound mail is a thing (not yet).

## 3. Worker resources (once per account)

```sh
wrangler d1 create nbread          # → paste database_id into wrangler.jsonc
wrangler d1 migrations apply nbread --remote
wrangler kv namespace create KV       # → paste id into wrangler.jsonc
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put ADMIN_PUBKEY      # OPTIONAL: hex/npub admin identity for /admin
                                      # (omit → admin surface disabled, all /admin 404)
```

- [ ] Create a Turnstile widget (dashboard → Turnstile) for `nbread.lol`
      **plus the workers.dev preview hostname** (Gate A tests the claim flow
      there); put the site key in `wrangler.jsonc` `vars.TURNSTILE_SITE_KEY`
      and the secret via `wrangler secret put`.
- `vars.ENVIRONMENT` is already `"production"` in the committed
  `wrangler.jsonc` (fail closed — deploys never enable the dev-only
  X-Forwarded-Host override). Local dev gets `ENVIRONMENT=development` from
  `.dev.vars` (copy `.dev.vars.example`); do not flip the committed var.

## 4. Routes + cron (deployed from wrangler.jsonc)

`wrangler deploy` registers:

- routes `nbread.lol/*` and `*.nbread.lol/*` (zone `nbread.lol`)
- cron trigger `*/15 * * * *`

- [ ] After first deploy, verify both routes appear under the zone's
      Workers Routes page and the cron shows in the Worker's Triggers tab.
- [ ] Tail logs (`wrangler tail`) across one 15-minute boundary to observe a
      cron execution.

## 5. Launch gates (P7 runbook — full detail in `docs/ops.md` §6)

- Gate A: `wrangler deploy --var MAIN_HOST:nbread.<account>.workers.dev`
  to the `workers.dev` preview URL; CI green +
  `bash scripts/smoke.sh https://nbread.<account>.workers.dev` green
  (subdomain checks auto-skip on workers.dev).
- Gate B: flip DNS (section 2), `wrangler deploy` (committed vars), re-run
  smoke against `https://nbread.lol`, confirm cron observed in
  `wrangler tail`, and verify a claimed test blog renders real relay content.
- Post-launch: configure the WAF rate rule + scanner-path block
  (`docs/ops.md` §3) and set `ADMIN_PUBKEY` if the blocklist admin is wanted
  (`docs/ops.md` §5).

## 6. Deployment record

Account **Sovereign IT** (`2d2cca1238913def0ad9cc1f598a8e0b`).

### Reused resources — carry over from the original launch (LIVE)

These bind by id and hold the existing data; the `nostrbook → nbread` rename
reuses them unchanged (the wrangler `database_name` label is cosmetic — D1 binds
by `database_id`):

- **D1** `e9163b12-3cde-4b82-961b-b825c85321e3` (region ENAM); all migrations
  applied `--remote`; reserved handles seeded. Labelled `nbread` in
  `wrangler.jsonc`.
- **KV** `75a4c5d58e1f449080bf8be64a995a5a` (binding `KV`).

### nbread.lol migration — PENDING (target state after the domain migration)

The project moved from `nostrbook.net` to **`nbread.lol`**. The following are the
target state and are **not yet provisioned** — the committed `wrangler.jsonc`
points at them, but they must be created before `wrangler deploy` serves traffic:

- **Zone** `nbread.lol` on the Sovereign IT account: NS active, SSL **Full
  (strict)**, Universal SSL covering `nbread.lol` + `*.nbread.lol`, Always Use
  HTTPS + HSTS.
- **DNS** (proxied): apex `A @ 192.0.2.1`, apex `AAAA @ 100::`, wildcard
  `CNAME * → nbread.lol`.
- **Turnstile**: the site key currently in `wrangler.jsonc`
  (`0x4AAAAAAD1JzzXDBykpiavq`) is the **old nostrbook.net widget** and will fail
  the hostname check on `nbread.lol`. Create/point a widget at `nbread.lol` +
  `nbread.cameron-2d2.workers.dev`, then update `TURNSTILE_SITE_KEY` and
  `wrangler secret put TURNSTILE_SECRET_KEY`.
- **Worker `nbread`**: renaming the worker creates a NEW worker on deploy — routes
  `nbread.lol/*` + `*.nbread.lol/*`, cron `*/15`, and secrets
  (`TURNSTILE_SECRET_KEY`, `ADMIN_PUBKEY`) do not carry over from the old
  `nostrbook` worker and must be (re-)attached.
- **WAF**: recreate `global-per-ip-throttle` (60 req/10s per IP, block 10s) +
  `scanner-paths-block` (`.php`, `/wp-`, `/.env`, `.git/` → block) with host
  `nbread.lol`.

The old `nostrbook` worker / `nostrbook.net` zone keep serving until explicitly
retired — decommission is a separate step.
