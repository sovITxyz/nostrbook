#!/usr/bin/env bash
# nbread.lol smoke tests. Grows every phase.
#
# Usage:
#   bash scripts/smoke.sh local                 # boots wrangler dev, tests, kills it
#   bash scripts/smoke.sh https://nbread.lol # tests an already-running deployment
set -euo pipefail

TARGET="${1:-local}"
DEV_PID=""

cleanup() {
  if [[ -n "$DEV_PID" ]]; then
    # wrangler dev is a process tree (npx → node → workerd); kill the whole
    # process group (setsid below makes DEV_PID its leader) or workerd
    # survives and squats on :8787 for the next run.
    kill -- "-$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "$TARGET" == "local" ]]; then
  BASE="http://127.0.0.1:8787"
  MAIN_HOST="nbread.lol"
  if curl -sf -o /dev/null --max-time 2 "$BASE/healthz" 2>/dev/null; then
    echo "FAIL: something is already listening on :8787 — kill it first" >&2
    echo "      (otherwise these checks would silently test a stale server)" >&2
    exit 1
  fi
  echo "==> applying D1 migrations (local)"
  npx wrangler d1 migrations apply nbread --local >/dev/null
  echo "==> starting wrangler dev on :8787"
  # ENVIRONMENT=development enables the dev-only X-Forwarded-Host override the
  # checks below rely on (wrangler.jsonc ships production; --var also covers
  # fresh clones without a .dev.vars file).
  setsid npx wrangler dev --port 8787 --inspector-port 0 \
    --var ENVIRONMENT:development >/dev/null 2>&1 &
  DEV_PID=$!
  for i in $(seq 1 60); do
    if curl -sf -o /dev/null "$BASE/healthz"; then break; fi
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "FAIL: wrangler dev exited early" >&2
      exit 1
    fi
    sleep 1
  done
else
  BASE="$TARGET"
  MAIN_HOST="$(echo "$TARGET" | sed -E 's#^https?://##; s#/.*$##; s#:.*$##')"
fi

# Subdomain-host checks cannot run against a workers.dev preview (Gate A):
# nested subdomains of *.workers.dev have no DNS/TLS. They run locally (via
# the X-Forwarded-Host override) and against the real zone (Gate B).
SUBDOMAINS=1
if [[ "$TARGET" != "local" && "$MAIN_HOST" == *workers.dev ]]; then
  SUBDOMAINS=0
fi

PASS=0
FAIL=0

# check <desc> <expected-code> <host> <path>
# Local mode: wrangler dev's proxy rewrites the Host header, so the dev-only
# X-Forwarded-Host override (honored only when ENVIRONMENT=development) is
# used to select the tenant. Remote mode: hits the real host in the URL.
check() {
  local desc="$1" expected="$2" host_header="$3" path="$4"
  local args=(-s -o /tmp/smoke_body -D /tmp/smoke_headers -w '%{http_code}' --max-time 15)
  local url
  if [[ "$TARGET" == "local" ]]; then
    url="$BASE$path"
    if [[ -n "$host_header" ]]; then
      args+=(-H "X-Forwarded-Host: $host_header")
    fi
  else
    url="https://$host_header$path"
  fi
  local code
  code=$(curl "${args[@]}" "$url" || echo "000")
  if [[ "$code" == "$expected" ]]; then
    echo "PASS  [$code] $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL  [$code != $expected] $desc"
    FAIL=$((FAIL + 1))
  fi
}

check_body_contains() {
  local desc="$1" needle="$2"
  if grep -q "$needle" /tmp/smoke_body; then
    echo "PASS  [body] $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL  [body] $desc (missing: $needle)"
    FAIL=$((FAIL + 1))
  fi
}

check_header_contains() {
  local desc="$1" needle="$2"
  if grep -qi "$needle" /tmp/smoke_headers; then
    echo "PASS  [hdr]  $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL  [hdr]  $desc (missing: $needle)"
    FAIL=$((FAIL + 1))
  fi
}

# check_post <desc> <expected-code> <host> <path> <json-body> [origin]
check_post() {
  local desc="$1" expected="$2" host_header="$3" path="$4" data="$5" origin="${6:-}"
  local args=(-s -o /tmp/smoke_body -D /tmp/smoke_headers -w '%{http_code}' \
    --max-time 15 -X POST -H 'Content-Type: application/json' --data "$data")
  if [[ -n "$origin" ]]; then
    args+=(-H "Origin: $origin")
  fi
  local url
  if [[ "$TARGET" == "local" ]]; then
    url="$BASE$path"
    if [[ -n "$host_header" ]]; then
      args+=(-H "X-Forwarded-Host: $host_header")
    fi
  else
    url="https://$host_header$path"
  fi
  local code
  code=$(curl "${args[@]}" "$url" || echo "000")
  if [[ "$code" == "$expected" ]]; then
    echo "PASS  [$code] $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL  [$code != $expected] $desc"
    FAIL=$((FAIL + 1))
  fi
}

# check_accept <desc> <expected-code> <host> <path> <accept>
# Like check(), but sends an Accept header — used for the NIP-11 relay
# document (application/nostr+json). Leaves the response body in
# /tmp/smoke_body and headers in /tmp/smoke_headers for the check_body_contains
# / check_header_contains assertions that follow.
check_accept() {
  local desc="$1" expected="$2" host_header="$3" path="$4" accept="$5"
  local args=(-s -o /tmp/smoke_body -D /tmp/smoke_headers -w '%{http_code}' \
    --max-time 15 -H "Accept: $accept")
  local url
  if [[ "$TARGET" == "local" ]]; then
    url="$BASE$path"
    if [[ -n "$host_header" ]]; then
      args+=(-H "X-Forwarded-Host: $host_header")
    fi
  else
    url="https://$host_header$path"
  fi
  local code
  code=$(curl "${args[@]}" "$url" || echo "000")
  if [[ "$code" == "$expected" ]]; then
    echo "PASS  [$code] $desc"
    PASS=$((PASS + 1))
  else
    echo "FAIL  [$code != $expected] $desc"
    FAIL=$((FAIL + 1))
  fi
}

# --- P0: hello checks ---------------------------------------------------------
check "apex / responds 200" 200 "$MAIN_HOST" "/"
check_body_contains "apex / mentions nbread.lol" "nbread.lol"
check "apex /healthz responds 200" 200 "$MAIN_HOST" "/healthz"
check_body_contains "healthz reports ok" '"ok":true'
if [[ "$SUBDOMAINS" == 1 ]]; then
  check "unclaimed subdomain is 404" 404 "unknown.$MAIN_HOST" "/"
else
  echo "SKIP  unclaimed-subdomain check (no wildcard subdomains on workers.dev)"
fi
check "static asset css served" 200 "$MAIN_HOST" "/css/style.css"

if [[ "$TARGET" == "local" ]]; then
  # Host-class spoof checks need header injection — local only (remote DNS
  # would never resolve these hosts anyway).
  check "spoofed host class is 404" 404 "$MAIN_HOST.evil.com" "/"
  check "deep subdomain is 404" 404 "a.b.$MAIN_HOST" "/"
fi

# --- P3: ingestion + public blogs ----------------------------------------------
# A shape-valid npub with a bad checksum must 404 (no relay fetch happens).
check "malformed npub is 404" 404 "$MAIN_HOST" "/npub1$(printf 'z%.0s' $(seq 1 58))"

# --- P4: auth + handle claim + NIP-05 -------------------------------------------
check "login page responds 200" 200 "$MAIN_HOST" "/login"
check_body_contains "login page ships the NIP-07 button" "login-button"
check "login.js asset served" 200 "$MAIN_HOST" "/js/login.js"
# Nonce store is D1 (login_nonces, ratified P4 addendum): issuance must work
# against a real migrated database, not just the vitest-applied schema.
check "login challenge issues a nonce" 200 "$MAIN_HOST" "/login/challenge"
check_body_contains "challenge body carries a nonce + ttl" '"challenge":"'
check_body_contains "challenge ttl is 300s" '"ttl":300'
check "nip05 unknown name responds 200" 200 "$MAIN_HOST" "/.well-known/nostr.json?name=nosuchuser"
check_body_contains "nip05 unknown name is empty" '"names":{}'
check_header_contains "nip05 sends CORS *" "access-control-allow-origin: \*"
check "dashboard redirects anonymous to login" 302 "$MAIN_HOST" "/dashboard"
check_post "login rejects a garbage body" 400 "$MAIN_HOST" "/login" '{"not":"an event"}'
check_post "login enforces CSRF (cross-origin)" 403 "$MAIN_HOST" "/login" '{}' "https://evil.example"
check_post "claim requires a session" 401 "$MAIN_HOST" "/dashboard/claim" '{}'

# --- P5: editor + dashboard ------------------------------------------------------
check "editor (new post) redirects anonymous to login" 302 "$MAIN_HOST" "/dashboard/posts/new"
check "editor (edit) redirects anonymous to login" 302 "$MAIN_HOST" "/dashboard/editor?slug=hello-world"
check "editor.js asset served" 200 "$MAIN_HOST" "/js/editor.js"
check_post "mirror API requires a session" 401 "$MAIN_HOST" "/api/mirror" '{}'
check_post "mirror API enforces CSRF (cross-origin)" 403 "$MAIN_HOST" "/api/mirror" '{}' "https://evil.example"
check_post "preview requires a session" 401 "$MAIN_HOST" "/dashboard/preview" '{"markdown":"# hi"}'
check_post "settings require a session" 401 "$MAIN_HOST" "/dashboard/settings" '{}'
check_post "settings enforce CSRF (cross-origin)" 403 "$MAIN_HOST" "/dashboard/settings" '{}' "https://evil.example"

# --- P6: discover + search -------------------------------------------------------
check "discover responds 200" 200 "$MAIN_HOST" "/discover"
check_body_contains "discover page renders" "Discover"
check_header_contains "discover sends a public s-maxage" "s-maxage"
check "discover clamps garbage paging" 200 "$MAIN_HOST" "/discover?page=-999"
# page=-999 clamps to page 1, which the first /discover check primed into the
# Cache API — a real cache layer (review fix), not just an advisory header.
check_header_contains "discover repeat serves from the Worker cache" "x-nbread-cache: hit"
check "search form responds 200" 200 "$MAIN_HOST" "/search"
check_body_contains "search page ships the form" 'name="q"'
check "search with a query responds 200" 200 "$MAIN_HOST" "/search?q=hello"
# FTS injection string: '"NEAR( title:x OR * -' — must be a 200, never a 5xx.
check "search survives an FTS injection string" 200 "$MAIN_HOST" "/search?q=%22NEAR(%20title%3Ax%20OR%20*%20-"
check "polished landing responds 200" 200 "$MAIN_HOST" "/"
check_body_contains "landing carries the login CTA" 'href="/login"'
check_body_contains "landing links to discover" 'href="/discover"'

# --- P7: security headers + admin surface -----------------------------------------
check "apex headers probe responds 200" 200 "$MAIN_HOST" "/"
check_header_contains "apex sends nosniff" "x-content-type-options: nosniff"
check_header_contains "apex sends referrer-policy" "referrer-policy: strict-origin-when-cross-origin"
check_header_contains "apex sends X-Frame-Options DENY" "x-frame-options: deny"
check_header_contains "apex CSP is the apex class" "content-security-policy: default-src 'none'; script-src 'self' https://challenges.cloudflare.com"
# The /npub1… views are BLOG-class even on the apex: their CSP starts
# img-src (no script-src at all — blog pages are JS-free by policy).
check "npub headers probe is 404" 404 "$MAIN_HOST" "/npub1$(printf 'z%.0s' $(seq 1 58))"
check_header_contains "npub view carries the blog-class CSP" "content-security-policy: default-src 'none'; img-src"
# Review fix: the blog class pins base-uri AND form-action (apex pins
# base-uri 'none' too, but form-action 'self' — this pair is blog-only).
check_header_contains "blog CSP pins base-uri + form-action" "base-uri 'none'; form-action 'none'"
check_header_contains "npub 404 still sends nosniff" "x-content-type-options: nosniff"
if [[ "$SUBDOMAINS" == 1 ]]; then
  check "unknown subdomain headers probe is 404" 404 "unknown.$MAIN_HOST" "/"
  check_header_contains "unknown-subdomain 404 sends nosniff" "x-content-type-options: nosniff"
  check_header_contains "unknown-subdomain 404 carries a CSP" "content-security-policy: default-src 'none'"
else
  echo "SKIP  subdomain header checks (no wildcard subdomains on workers.dev)"
fi
# /admin is invisible unless ADMIN_PUBKEY is set AND the caller holds the
# admin session: local dev leaves the secret unset (surface disabled), prod
# hides it from anonymous callers — 404 either way.
check "admin surface hidden (disabled or anonymous)" 404 "$MAIN_HOST" "/admin"
check_post "admin actions hidden too" 404 "$MAIN_HOST" "/admin/block" '{"target":"alice"}'

# --- P8: first-party relay (#5) --------------------------------------------------
# A bare GET is the plain-text info page (Worker-served, no DO cost); the
# NIP-11 document comes back only for Accept: application/nostr+json. The ws
# upgrade itself is exercised by the integration suite (curl can't drive a
# NIP-01 session) and by the manual checklist, not here.
check "relay info page responds 200" 200 "$MAIN_HOST" "/relay"
check_body_contains "relay info page names the ws endpoint" "wss://$MAIN_HOST/relay"
check_accept "relay serves the NIP-11 document" 200 "$MAIN_HOST" "/relay" "application/nostr+json"
check_body_contains "relay NIP-11 advertises NIP-42" '"supported_nips":\[1,9,11,42\]'
check_body_contains "relay NIP-11 restricts writes" '"restricted_writes":true'
check_header_contains "relay NIP-11 sends CORS *" "access-control-allow-origin: \*"

# --- P5 MANUAL check (documented, not automated): full write→render loop ---------
# The end-to-end publish flow needs a REAL NIP-07 extension signing in a real
# browser, which curl cannot drive. Once per release, verify by hand:
#   1. `npx wrangler dev` and open http://127.0.0.1:8787/login in a browser
#      with a NIP-07 extension (Alby / nos2x) installed;
#   2. sign in (extension prompt), claim a handle on /dashboard;
#   3. /dashboard → "New post" → write markdown → Preview (server-rendered,
#      identical to the publish pipeline) → "Sign & publish" (extension
#      prompt) — the editor POSTs the signed event to /api/mirror and
#      broadcasts it to the configured relays;
#   4. confirm the post renders on the blog host, then Edit → republish
#      (replaceable update wins) and Delete (signed kind 5) → post disappears.

echo
echo "smoke: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
