#!/bin/sh
# e2e purge loop: render → HIT → write → purge → MISS with fresh body.
# Usage: ./verify.sh [ols|caddy|caddy-node|caddy-bun|angie|all]  (default: caddy)
# `all` sweeps every target, streams each step live, keeps going past
# failures, and ends with a PASS/FAIL summary table (non-zero exit on any
# failure). Full run: ./verify.sh all
#
# Stack lifecycle — own what you start: if the compose stack is not running,
# it is started here and torn down on exit (pass or fail); a stack you
# started manually (docker compose up -d --build) is left untouched so
# iterating stays fast.
set -eu
cd "$(dirname "$0")"

HOST="${1:-caddy}"
NET="drizzle-page-cache-e2e_default"

if [ -z "$(docker compose ps -q --status running 2>/dev/null)" ]; then
  echo "== stack not running — starting it (and tearing it down on exit) =="
  trap 'echo "== tearing down the stack this run started =="; docker compose down' EXIT INT TERM
  docker compose up -d --build
  sleep 3 # proxies without healthchecks need a beat after their apps go healthy
fi

# Preference order: OLS, Caddy (Deno/Node/Bun), Angie (Varnish and nginx are
# bench-only pairings — no purge loop to verify).
ALL_TARGETS="ols caddy caddy-node caddy-bun angie"

if [ "$HOST" = "all" ]; then
  self="$0"
  failed=""
  summary=""
  for t in $ALL_TARGETS; do
    start=$(date +%s)
    if "$self" "$t"; then result=PASS; else result=FAIL; failed="$failed $t"; fi
    summary="$summary$(printf '%-12s %-4s %3ss' "$t" "$result" "$(($(date +%s) - start))")\n"
    echo
  done
  echo "== summary =="
  printf "$summary"
  [ -z "$failed" ] || { echo "FAILED:$failed"; exit 1; }
  exit 0
fi

# OpenLiteSpeed purges are internally batched — allow it a moment.
case "$HOST" in ols) PURGE_WAIT=4 ;; *) PURGE_WAIT=1 ;; esac

curl_() { docker run --rm --network "$NET" curlimages/curl:latest -s "$@"; }

# Souin: Cache-Status; LiteSpeed: X-LiteSpeed-Cache; Angie/nginx: X-Cache-Status
status() {
  curl_ -D - -o /dev/null "$HOST$1" |
    grep -iE '^(cache-status|x-litespeed-cache|x-cache-status):' || true
}

# On a failed step, dump the full response headers of the offending request
# before exiting — one grepped header line is rarely enough to debug.
fail() {
  echo "   FAILED at step $1 — full response headers of $HOST$2:"
  curl_ -D - -o /dev/null "$HOST$2" | sed 's/^/   | /'
  exit 1
}

echo "== target: $HOST =="

# Unique query string per run: step 1 is a genuine MISS even on a warm cache,
# and step 5 additionally proves tag purges evict query-string variants.
V="$(date +%s)"
P="/post/3?v=$V"

echo "1) first request is a MISS (stored)"
s1=$(status "$P"); echo "   $s1"
echo "$s1" | grep -qiE 'stored|miss' || fail 1 "$P"

echo "2) second request is a HIT"
s2=$(status "$P"); echo "   $s2"
echo "$s2" | grep -qi 'hit' || fail 2 "$P"

# Angie purges by URL pattern, not tag: `PURGE /post/*` is a prefix match on
# the cache key. Warm a SECOND entry under the prefix to prove the wildcard
# clears entries beyond the row that was written.
if [ "$HOST" = "angie" ]; then
  W="/post/2?v=$V"
  echo "2b) warm a second entry under /post/ (wildcard witness)"
  status "$W" > /dev/null
  s2b=$(status "$W"); echo "   $s2b"
  echo "$s2b" | grep -qi 'hit' || fail 2b "$W"
fi

echo "3) body snapshot before write"
before=$(curl_ "$HOST$P")

echo "4) write via POST (uncached), triggers tag purge"
curl_ -X POST -d "title=Edited+$(date +%s)" "$HOST/edit/3" > /dev/null
sleep "$PURGE_WAIT"

echo "5) next request is a MISS with fresh content"
s3=$(status "$P"); echo "   $s3"
echo "$s3" | grep -qvi 'hit' || fail 5 "$P"
after=$(curl_ "$HOST$P")
{ [ "$before" != "$after" ] && echo "$after" | grep -q 'Edited'; } ||
  fail "5 (body)" "$P"

if [ "$HOST" = "angie" ]; then
  echo "5b) the second entry was also evicted by the wildcard purge"
  s5b=$(status "$W"); echo "   $s5b"
  echo "$s5b" | grep -qvi 'hit' || fail 5b "$W"
fi

echo "PASS: purge loop verified against $HOST"
