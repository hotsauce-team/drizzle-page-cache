#!/bin/sh
# e2e purge loop: render → HIT → write → purge → MISS with fresh body.
# Usage: ./verify.sh [caddy|caddy-node|caddy-bun|ols]   (default: caddy)
# Full run: docker compose up -d --build
#           ./verify.sh caddy && ./verify.sh caddy-node && ./verify.sh caddy-bun && ./verify.sh ols
set -eu

HOST="${1:-caddy}"
NET="drizzle-page-cache-e2e_default"
# OpenLiteSpeed purges are internally batched — allow it a moment.
case "$HOST" in ols) PURGE_WAIT=4 ;; *) PURGE_WAIT=1 ;; esac

curl_() { docker run --rm --network "$NET" curlimages/curl:latest -s "$@"; }

# Souin: Cache-Status; LiteSpeed: X-LiteSpeed-Cache
status() {
  curl_ -D - -o /dev/null "$HOST$1" |
    grep -iE '^(cache-status|x-litespeed-cache):' || true
}

echo "== target: $HOST =="

# Unique query string per run: step 1 is a genuine MISS even on a warm cache,
# and step 5 additionally proves tag purges evict query-string variants.
P="/post/3?v=$(date +%s)"

echo "1) first request is a MISS (stored)"
s1=$(status "$P"); echo "   $s1"; echo "$s1" | grep -qiE 'stored|miss'

echo "2) second request is a HIT"
s2=$(status "$P"); echo "   $s2"; echo "$s2" | grep -qi 'hit'

echo "3) body snapshot before write"
before=$(curl_ "$HOST$P")

echo "4) write via POST (uncached), triggers tag purge"
curl_ -X POST -d "title=Edited+$(date +%s)" "$HOST/edit/3" > /dev/null
sleep "$PURGE_WAIT"

echo "5) next request is a MISS with fresh content"
s3=$(status "$P"); echo "   $s3"; echo "$s3" | grep -qvi 'hit'
after=$(curl_ "$HOST$P")
[ "$before" != "$after" ] && echo "$after" | grep -q 'Edited'

echo "PASS: purge loop verified against $HOST"
