#!/bin/sh
# e2e purge loop: render → HIT → write → purge → MISS with fresh body →
# HIT again. The nginx family (angie, nginx, nginx-ls) additionally
# exercises the Lua tag transports end to end: list-page purging, row
# precision (editing post 3 must NOT evict post 2), the log-phase record
# (refreshed entries become HITs again), and — for purge.lua — the /__dpc/
# purge API contract. nginx-ls runs purge_litespeed.lua: the LiteSpeed
# dialect (header-driven purging via the litespeed entrypoint) on plain
# nginx.
# Usage: ./verify.sh [ols|caddy|caddy-node|caddy-bun|angie|nginx|nginx-ls|all]  (default: caddy)
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

# Preference order: OLS, Caddy (Deno/Node/Bun), Angie, nginx (Varnish is a
# bench-only pairing — no purge loop to verify).
ALL_TARGETS="ols caddy caddy-node caddy-bun angie nginx nginx-ls"

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

# The nginx family runs the Lua tag transports, which get extra
# assertions; only purge.lua (angie, nginx) serves the /__dpc/ purge API —
# purge_litespeed.lua (nginx-ls) is purged by response headers instead.
case "$HOST" in angie | nginx | nginx-ls) LUA=1 ;; *) LUA="" ;; esac
case "$HOST" in angie | nginx) PURGE_API=1 ;; *) PURGE_API="" ;; esac

# Unique query string per run: step 1 is a genuine MISS even on a warm cache,
# and step 5 additionally proves purges reach query-string variants.
V="$(date +%s)"
P="/post/3?v=$V"

echo "1) first request is a MISS (stored)"
s1=$(status "$P"); echo "   $s1"
echo "$s1" | grep -qiE 'stored|miss' || fail 1 "$P"

echo "2) second request is a HIT"
s2=$(status "$P"); echo "   $s2"
echo "$s2" | grep -qi 'hit' || fail 2 "$P"

if [ -n "$LUA" ]; then
  # Warm a row that will NOT be written (precision witness) and the list
  # page (tagged `posts`, so the write MUST refresh it).
  W="/post/2?v=$V"
  echo "2b) warm an unrelated row entry (precision witness)"
  status "$W" > /dev/null
  s2b=$(status "$W"); echo "   $s2b"
  echo "$s2b" | grep -qi 'hit' || fail 2b "$W"
  echo "2c) warm the list page (table-tag witness)"
  status "/" > /dev/null
  s2c=$(status "/"); echo "   $s2c"
  echo "$s2c" | grep -qi 'hit' || fail 2c "/"
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

if [ -n "$LUA" ]; then
  echo "5b) the write purged the row tag as a BYPASS, not a coincidence"
  echo "$s3" | grep -qi 'bypass' || fail 5b "$P"
  echo "5c) the list page (tag: posts) was refreshed with the new title"
  s5c=$(status "/"); echo "   $s5c"
  echo "$s5c" | grep -qi 'bypass' || fail 5c "/"
  curl_ "$HOST/" | grep -q 'Edited' || fail "5c (body)" "/"
  echo "5d) precision: the unwritten row is STILL a HIT (no over-purge)"
  s5d=$(status "$W"); echo "   $s5d"
  echo "$s5d" | grep -qi 'hit' || fail 5d "$W"
fi

echo "6) the refreshed entry is cacheable again (HIT)"
s6=$(status "$P"); echo "   $s6"
echo "$s6" | grep -qi 'hit' || fail 6 "$P"

if [ -n "$PURGE_API" ]; then
  echo "7) purge API contract (/__dpc/, Fastly-shaped routes)"
  c7a=$(curl_ -o /dev/null -w '%{http_code}' -X POST "$HOST/__dpc/purge")
  echo "   POST /purge without Surrogate-Key -> $c7a"
  [ "$c7a" = "400" ] || fail "7 (missing header)" "/__dpc/purge"
  c7comma=$(curl_ -o /dev/null -w '%{http_code}' -X POST \
    -H "Surrogate-Key: posts:3,posts" "$HOST/__dpc/purge")
  echo "   POST /purge comma-separated (wrong dialect) -> $c7comma"
  [ "$c7comma" = "400" ] || fail "7 (comma rejected)" "/__dpc/purge"
  c7b=$(curl_ -o /dev/null -w '%{http_code}' -X POST \
    -H "Surrogate-Key: no-such-tag" "$HOST/__dpc/purge")
  echo "   POST /purge unknown tag -> $c7b"
  [ "$c7b" = "200" ] || fail "7 (unknown tag)" "/__dpc/purge"
  b7=$(curl_ -X POST -H "Surrogate-Key: no-such-tag" "$HOST/__dpc/purge")
  echo "   headerless purge echoes the mark-TTL cap: $b7"
  echo "$b7" | grep -q '"markTtl":2592000' || fail "7 (markTtl cap)" "/__dpc/purge"
  b7x=$(curl_ -X POST -H "Surrogate-Key: no-such-tag" \
    -H "X-DPC-Mark-TTL: 120" "$HOST/__dpc/purge")
  echo "   X-DPC-Mark-TTL sizes the mark: $b7x"
  echo "$b7x" | grep -q '"markTtl":120' || fail "7 (markTtl header)" "/__dpc/purge"
  s7=$(status "$P"); echo "   $s7"
  echo "$s7" | grep -qi 'hit' || fail "7 (still hit)" "$P"
  c7c=$(curl_ -o /dev/null -w '%{http_code}' "$HOST/__dpc/purge")
  echo "   GET /purge -> $c7c"
  [ "$c7c" = "405" ] || fail "7 (method)" "/__dpc/purge"

  echo "7b) single-tag route evicts exactly its row"
  c7d=$(curl_ -o /dev/null -w '%{http_code}' -X POST "$HOST/__dpc/purge/posts:2")
  [ "$c7d" = "200" ] || fail "7b (single purge)" "/__dpc/purge/posts:2"
  s7b=$(status "$W"); echo "   $s7b"
  echo "$s7b" | grep -qi 'bypass' || fail "7b (witness evicted)" "$W"
  s7c=$(status "$P"); echo "   $s7c"
  echo "$s7c" | grep -qi 'hit' || fail "7b (other row untouched)" "$P"

  echo "7c) purge_all evicts everything"
  c7e=$(curl_ -o /dev/null -w '%{http_code}' -X POST "$HOST/__dpc/purge_all")
  [ "$c7e" = "200" ] || fail "7c (purge_all)" "/__dpc/purge_all"
  s7d=$(status "$P"); echo "   $s7d"
  echo "$s7d" | grep -qi 'bypass' || fail "7c (evicted)" "$P"
  s7e=$(status "$P"); echo "   $s7e"
  echo "$s7e" | grep -qi 'hit' || fail "7c (hit again)" "$P"
fi

echo "PASS: purge loop verified against $HOST"
