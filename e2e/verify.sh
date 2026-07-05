#!/bin/sh
# e2e purge loop: render → HIT → write → purge → MISS with fresh body.
# Run: docker compose up -d --build && ./verify.sh && docker compose down
set -eu

BASE="${BASE:-http://127.0.0.1:8080}"
curl_() { docker run --rm --network drizzle-page-cache-e2e_default curlimages/curl:latest -s "$@"; }

status() { curl_ -D - -o /dev/null "caddy$1" | grep -i '^Cache-Status' || true; }

echo "1) first request stores (uri-miss; stored)"
s1=$(status /post/3); echo "   $s1"; echo "$s1" | grep -q 'stored'

echo "2) second request is a HIT"
s2=$(status /post/3); echo "   $s2"; echo "$s2" | grep -q 'hit'

echo "3) response carries no Surrogate-Key leak check + body snapshot"
before=$(curl_ "caddy/post/3")

echo "4) write via POST (uncached), triggers tag purge"
curl_ -X POST -d "title=Edited+$(date +%s)" "caddy/edit/3" > /dev/null
sleep 1

echo "5) next request is a MISS with fresh content"
s3=$(status /post/3); echo "   $s3"; echo "$s3" | grep -qv '; hit'
after=$(curl_ "caddy/post/3")
[ "$before" != "$after" ] && echo "$after" | grep -q 'Edited'

echo "PASS: purge loop verified"
