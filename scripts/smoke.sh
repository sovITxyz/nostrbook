#!/usr/bin/env bash
# Nostrbook smoke tests. Grows every phase.
#
# Usage:
#   bash scripts/smoke.sh local                 # boots wrangler dev, tests, kills it
#   bash scripts/smoke.sh https://nostrbook.net # tests an already-running deployment
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
  MAIN_HOST="nostrbook.net"
  if curl -sf -o /dev/null --max-time 2 "$BASE/healthz" 2>/dev/null; then
    echo "FAIL: something is already listening on :8787 — kill it first" >&2
    echo "      (otherwise these checks would silently test a stale server)" >&2
    exit 1
  fi
  echo "==> applying D1 migrations (local)"
  npx wrangler d1 migrations apply nostrbook --local >/dev/null
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

# --- P0: hello checks ---------------------------------------------------------
check "apex / responds 200" 200 "$MAIN_HOST" "/"
check_body_contains "apex / mentions Nostrbook" "Nostrbook"
check "apex /healthz responds 200" 200 "$MAIN_HOST" "/healthz"
check_body_contains "healthz reports ok" '"ok":true'
check "unclaimed subdomain is 404" 404 "unknown.$MAIN_HOST" "/"
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

echo
echo "smoke: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
