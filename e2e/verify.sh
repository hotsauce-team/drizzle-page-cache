#!/bin/sh
# e2e purge loop: render → HIT → write → purge → MISS with fresh body.
# Usage: ./verify.sh [caddy|caddy-node]   (default: caddy — the Deno app)
# Full run: docker compose up -d --build && ./verify.sh caddy && ./verify.sh caddy-node
set -eu

HOST="${1:-caddy}"
NET="drizzle-page-cache-e2e_default"
curl_() { docker run --rm --network "$NET" curlimages/curl:latest -s "$@"; }

status() { curl_ -D - -o /dev/null "$HOST$1" | grep -i '^Cache-Status' || true; }

echo "== target: $HOST =="

echo "1) first request stores (uri-miss; stored)"
s1=$(status /post/3); echo "   $s1"; echo "$s1" | grep -q 'stored'

echo "2) second request is a HIT"
s2=$(status /post/3); echo "   $s2"; echo "$s2" | grep -q 'hit'

echo "3) body snapshot before write"
before=$(curl_ "$HOST/post/3")

echo "4) write via POST (uncached), triggers tag purge"
curl_ -X POST -d "title=Edited+$(date +%s)" "$HOST/edit/3" > /dev/null
sleep 1

echo "5) next request is a MISS with fresh content"
s3=$(status /post/3); echo "   $s3"; echo "$s3" | grep -qv '; hit'
after=$(curl_ "$HOST/post/3")
[ "$before" != "$after" ] && echo "$after" | grep -q 'Edited'

echo "PASS: purge loop verified against $HOST"
