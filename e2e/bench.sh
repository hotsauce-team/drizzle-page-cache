#!/bin/bash
# Local-only cache benchmark over the e2e stack. NOT CI material — numbers are
# only comparable within one machine/run. Methodology: k6 (in Docker) drives
# cache-hit traffic; CPU is read from cgroup v2 usage_usec deltas across every
# container serving the target, so "CPU-ms per request" includes proxy + app.
#
# Usage:
#   docker compose up -d --build
#   ./bench.sh              # all targets
#   ./bench.sh ols caddy    # specific targets
#
# Targets: app (no cache, baseline) | caddy (Souin+otter) | ols (OpenLiteSpeed)
#          nginx | angie (bench-only: no tag purging) | caddy-node | caddy-bun
#
# Tuning parity (so the comparison is fair):
#   nginx/angie  worker_processes auto, cache on /dev/shm (tmpfs), upstream
#                keepalive, keepalive_requests 100000, logs off
#   ols          httpdWorkers 6, storagepath on /dev/shm, access log kept
#                (OLS has no clean off switch at server level)
#   caddy        GOMAXPROCS=auto (all cores), otter is in-memory by design
#   k6           keep-alive by default; same VUS/DURATION for every target
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

cd "$(dirname "$0")"
NET="drizzle-page-cache-e2e_default"
PREFIX="drizzle-page-cache-e2e"
VUS="${VUS:-8}"
DURATION="${DURATION:-30s}"
OUT="bench-results"
mkdir -p "$OUT"

containers_for() {
  case "$1" in
    app) echo "$PREFIX-app-1" ;;
    caddy) echo "$PREFIX-caddy-1 $PREFIX-app-1" ;;
    caddy-node) echo "$PREFIX-caddy-node-1 $PREFIX-app-node-1" ;;
    caddy-bun) echo "$PREFIX-caddy-bun-1 $PREFIX-app-bun-1" ;;
    ols) echo "$PREFIX-ols-1 $PREFIX-app-ols-1" ;;
    nginx) echo "$PREFIX-nginx-1 $PREFIX-app-1" ;;
    angie) echo "$PREFIX-angie-1 $PREFIX-app-1" ;;
    *) echo "unknown target: $1" >&2; exit 1 ;;
  esac
}

base_for() {
  case "$1" in
    app) echo "http://app:8000" ;;
    *) echo "http://$1" ;;
  esac
}

cpu_usec() {
  local total=0 c v
  for c in $1; do
    v=$(docker exec "$c" cat /sys/fs/cgroup/cpu.stat | awk '/^usage_usec/{print $2}')
    total=$((total + v))
  done
  echo "$total"
}

mem_mb() {
  local total=0 c v
  for c in $1; do
    v=$(docker exec "$c" cat /sys/fs/cgroup/memory.current)
    total=$((total + v))
  done
  echo $((total / 1048576))
}

# Peak memory since container start (cgroup v2 memory.peak; falls back to
# memory.current on kernels without it).
mem_peak_mb() {
  local total=0 c v
  for c in $1; do
    v=$(docker exec "$c" sh -c 'cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory.current')
    total=$((total + v))
  done
  echo $((total / 1048576))
}

# Assert the uncached route really bypasses the cache on this target.
assert_uncached() {
  local base="$1" h
  h=$(docker run --rm --network "$NET" curlimages/curl:latest -s -D - -o /dev/null "$base/admin/uncached"
      docker run --rm --network "$NET" curlimages/curl:latest -s -D - -o /dev/null "$base/admin/uncached")
  if echo "$h" | grep -qiE '^(cache-status:.*; hit|x-cache-status: HIT|x-litespeed-cache: hit)'; then
    echo "FATAL: /admin/uncached is being cached on $base — results would be meaningless" >&2
    exit 1
  fi
}

bench_one() {
  local target="$1" label="$2" path="$3"
  local containers base
  containers=$(containers_for "$target")
  base=$(base_for "$target")

  # Warm caches/JITs on the same path, outside the measured window.
  docker run --rm --network "$NET" \
    -v "$PWD/bench:/scripts" -e BASE_URL="$base" -e TARGET_PATH="$path" \
    -e VUS=4 -e DURATION=10s \
    grafana/k6 run --quiet /scripts/script.js > /dev/null 2>&1

  local mem_before cpu_before cpu_after mem_after
  mem_before=$(mem_mb "$containers")
  cpu_before=$(cpu_usec "$containers")

  docker run --rm --network "$NET" \
    -v "$PWD/bench:/scripts" -v "$PWD/$OUT:/out" \
    -e BASE_URL="$base" -e TARGET_PATH="$path" -e VUS="$VUS" -e DURATION="$DURATION" \
    grafana/k6 run --quiet --summary-export="/out/$label.json" /scripts/script.js \
    > "$OUT/$label.log" 2>&1

  cpu_after=$(cpu_usec "$containers")
  mem_after=$(mem_mb "$containers")
  mem_peak=$(mem_peak_mb "$containers")

  deno eval '
    const [path, cb, ca, mb, ma, mp, target, out] = Deno.args;
    const s = JSON.parse(Deno.readTextFileSync(path));
    const reqs = s.metrics.http_reqs.count;
    const dur = s.metrics.http_req_duration;
    const cpuS = (Number(ca) - Number(cb)) / 1e6;
    const rec = {
      target,
      rps: Math.round(s.metrics.http_reqs.rate),
      p50_ms: Math.round(dur.med * 1000) / 1000,
      p95_ms: Math.round(dur["p(95)"] * 1000) / 1000,
      cpu_ms_per_req: reqs ? Math.round((cpuS * 1000 / reqs) * 10000) / 10000 : null,
      failed: s.metrics.http_req_failed?.value ?? null,
      mem_mb_before: Number(mb),
      mem_mb_after: Number(ma),
      mem_mb_peak: Number(mp),
    };
    const line = JSON.stringify(rec);
    console.log(line);
    Deno.writeTextFileSync(`${out}/records.jsonl`, line + "\n", { append: true });
  ' "$OUT/$label.json" "$cpu_before" "$cpu_after" "$mem_before" "$mem_after" "$mem_peak" "$label" "$OUT"
}

TARGETS=("${@:-app caddy ols nginx angie}")
[ $# -eq 0 ] && TARGETS=(app caddy ols nginx angie)
for t in ${TARGETS[@]+"${TARGETS[@]}"}; do
  if [ "$t" = "app" ]; then
    # Direct app = the no-proxy baseline for both scenarios.
    echo "== bench: app cache-hit path (VUS=$VUS DURATION=$DURATION) =="
    bench_one app app /post/3
    echo "== bench: app uncached path =="
    bench_one app app-uncached /admin/uncached
    continue
  fi
  echo "== bench: $t cache hits (VUS=$VUS DURATION=$DURATION) =="
  bench_one "$t" "$t" /post/3
  echo "== bench: $t uncached passthrough =="
  assert_uncached "$(base_for "$t")"
  bench_one "$t" "$t-uncached" /admin/uncached
done
