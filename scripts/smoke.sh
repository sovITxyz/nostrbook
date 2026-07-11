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
  local args=(-s -o /tmp/smoke_body -w '%{http_code}' --max-time 15)
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

echo
echo "smoke: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
