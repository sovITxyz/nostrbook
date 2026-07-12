# nostrbook.net — zone / DNS / infrastructure setup checklist

Manual, one-time steps done in the Cloudflare dashboard + wrangler CLI. Nothing
here is needed for local dev or CI; local D1/KV are simulated.

## 1. Zone

- [ ] Add the `nostrbook.net` zone to the Cloudflare account (free plan).
- [ ] Point the registrar's nameservers at the two Cloudflare-assigned NS hosts.
- [ ] Wait for the zone to become **Active**.
- [ ] SSL/TLS mode: **Full (strict)**.
- [ ] Edge Certificates: confirm the Universal SSL cert covers `nostrbook.net`
      and `*.nostrbook.net` (universal certs include the first-level wildcard).
- [ ] Edge Certificates (at Gate B, once TLS is confirmed working): enable
      **Always Use HTTPS** + **HSTS** (`max-age` ≥ 6 months; hold
      `includeSubDomains`/preload until tenant subdomains are confirmed stable
      on TLS — see `docs/ops.md` §6 Gate B step 1).

## 2. DNS records

| Type  | Name | Content                  | Proxy   |
| ----- | ---- | ------------------------ | ------- |
| A     | `@`  | `192.0.2.1` (dummy)      | Proxied |
| CNAME | `*`  | `nostrbook.net`          | Proxied |

- The apex A record is a placeholder — the Worker route intercepts all traffic;
  any proxied record works (or use a Workers **custom domain** on the apex
  instead, which manages the record automatically).
- The wildcard CNAME must be **proxied** (orange cloud) or subdomains bypass
  the Worker. Free plans proxy first-level wildcards fine.
- [ ] Optional: `_dmarc` TXT + SPF once outbound mail is a thing (not yet).

## 3. Worker resources (once per account)

```sh
wrangler d1 create nostrbook          # → paste database_id into wrangler.jsonc
wrangler d1 migrations apply nostrbook --remote
wrangler kv namespace create KV       # → paste id into wrangler.jsonc
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put ADMIN_PUBKEY      # OPTIONAL: hex/npub admin identity for /admin
                                      # (omit → admin surface disabled, all /admin 404)
```

- [ ] Create a Turnstile widget (dashboard → Turnstile) for `nostrbook.net`
      **plus the workers.dev preview hostname** (Gate A tests the claim flow
      there); put the site key in `wrangler.jsonc` `vars.TURNSTILE_SITE_KEY`
      and the secret via `wrangler secret put`.
- `vars.ENVIRONMENT` is already `"production"` in the committed
  `wrangler.jsonc` (fail closed — deploys never enable the dev-only
  X-Forwarded-Host override). Local dev gets `ENVIRONMENT=development` from
  `.dev.vars` (copy `.dev.vars.example`); do not flip the committed var.

## 4. Routes + cron (deployed from wrangler.jsonc)

`wrangler deploy` registers:

- routes `nostrbook.net/*` and `*.nostrbook.net/*` (zone `nostrbook.net`)
- cron trigger `*/15 * * * *`

- [ ] After first deploy, verify both routes appear under the zone's
      Workers Routes page and the cron shows in the Worker's Triggers tab.
- [ ] Tail logs (`wrangler tail`) across one 15-minute boundary to observe a
      cron execution.

## 5. Launch gates (P7 runbook — full detail in `docs/ops.md` §6)

- Gate A: `wrangler deploy --var MAIN_HOST:nostrbook.<account>.workers.dev`
  to the `workers.dev` preview URL; CI green +
  `bash scripts/smoke.sh https://nostrbook.<account>.workers.dev` green
  (subdomain checks auto-skip on workers.dev).
- Gate B: flip DNS (section 2), `wrangler deploy` (committed vars), re-run
  smoke against `https://nostrbook.net`, confirm cron observed in
  `wrangler tail`, and verify a claimed test blog renders real relay content.
- Post-launch: configure the WAF rate rule + scanner-path block
  (`docs/ops.md` §3) and set `ADMIN_PUBKEY` if the blocklist admin is wanted
  (`docs/ops.md` §5).
