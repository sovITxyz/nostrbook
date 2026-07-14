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

## 6. Deployment record & nbread.lol provisioning — PENDING

The project moved from `nostrbook.net` to **`nbread.lol`**. Provisioning is **not
done yet**; the committed `wrangler.jsonc` points at the target state below.

### Chosen strategy: fresh resources on the account that owns nbread.lol

`nbread.lol` is an **active zone on a different Cloudflare account** than the old
launch:

- **`nbread.lol`** → account `830ade508fd3f90a2a591477cdbd399c` (login
  `cameron@sovit.xyz` has access). **Target account for the deploy.**
- Old `nostrbook.net` + its D1 `e9163b12-3cde-4b82-961b-b825c85321e3` and KV
  `75a4c5d58e1f449080bf8be64a995a5a` live on **Sovereign IT**
  (`2d2cca1238913def0ad9cc1f598a8e0b`). Worker routes must bind a zone on the
  **same** account, so those old resources are **not reused**.

Decision (2026-07-14): **deploy on account `830ade…` with fresh D1 + KV.** The
~1-day-old nostrbook.net data does not carry over — reserved handles are re-seeded
and posts re-mirror from relays via cron.

### Next-session checklist (needs a scoped Cloudflare API token for `830ade…`)

Token scopes required: Workers Scripts:Edit, Workers Routes:Edit, D1:Edit,
Workers KV Storage:Edit, DNS:Edit, Zone Settings:Edit, SSL and Certificates:Edit,
Turnstile:Edit. Then:

1. `export CLOUDFLARE_ACCOUNT_ID=830ade508fd3f90a2a591477cdbd399c` (+ the token).
2. `wrangler d1 create nbread` → paste `database_id` into `wrangler.jsonc`.
3. `wrangler kv namespace create KV` → paste `id` into `wrangler.jsonc`.
4. `wrangler d1 migrations apply nbread --remote`; seed reserved handles.
5. **DNS** on `nbread.lol` (proxied): apex `A @ 192.0.2.1`, apex `AAAA @ 100::`,
   wildcard `CNAME * → nbread.lol`. SSL **Full (strict)**, Universal SSL covers
   `nbread.lol` + `*.nbread.lol`, Always Use HTTPS + HSTS.
6. **Turnstile**: new widget for `nbread.lol` + the `nbread.<account>.workers.dev`
   preview host → update `TURNSTILE_SITE_KEY` in `wrangler.jsonc`;
   `wrangler secret put TURNSTILE_SECRET_KEY`. (The committed key
   `0x4AAAAAAD1JzzXDBykpiavq` is the old nostrbook.net widget and will fail the
   nbread.lol hostname check.)
7. `wrangler secret put ADMIN_PUBKEY` (optional; unset ⇒ /admin 404s).
8. `wrangler deploy` → registers routes `nbread.lol/*` + `*.nbread.lol/*`,
   cron `*/15`.
9. **WAF**: `global-per-ip-throttle` (60 req/10s per IP, block 10s) +
   `scanner-paths-block` (`.php`, `/wp-`, `/.env`, `.git/` → block), host
   `nbread.lol`.
10. Verify: `bash scripts/smoke.sh https://nbread.lol` green; a claimed
    `handle.nbread.lol` renders; `/.well-known/nostr.json` returns
    `handle@nbread.lol`; cron observed in `wrangler tail`.

The old `nostrbook` worker / `nostrbook.net` zone keep serving until explicitly
retired — decommission is a separate step.
