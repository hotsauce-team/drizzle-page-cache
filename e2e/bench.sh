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
#          caddy-node | caddy-bun
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

bench_one() {
  local target="$1"
  local containers base
  containers=$(containers_for "$target")
  base=$(base_for "$target")

  # Warm the cache (and JITs) outside the measured window.
  docker run --rm --network "$NET" \
    -v "$PWD/bench:/scripts" -e BASE_URL="$base" -e VUS=4 -e DURATION=10s \
    grafana/k6 run --quiet /scripts/script.js > /dev/null 2>&1

  local mem_before cpu_before cpu_after mem_after
  mem_before=$(mem_mb "$containers")
  cpu_before=$(cpu_usec "$containers")

  docker run --rm --network "$NET" \
    -v "$PWD/bench:/scripts" -v "$PWD/$OUT:/out" \
    -e BASE_URL="$base" -e VUS="$VUS" -e DURATION="$DURATION" \
    grafana/k6 run --quiet --summary-export="/out/$target.json" /scripts/script.js \
    > "$OUT/$target.log" 2>&1

  cpu_after=$(cpu_usec "$containers")
  mem_after=$(mem_mb "$containers")

  deno eval '
    const [path, cb, ca, mb, ma, target, out] = Deno.args;
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
    };
    const line = JSON.stringify(rec);
    console.log(line);
    Deno.writeTextFileSync(`${out}/records.jsonl`, line + "\n", { append: true });
  ' "$OUT/$target.json" "$cpu_before" "$cpu_after" "$mem_before" "$mem_after" "$target" "$OUT"
}

TARGETS=("${@:-app caddy ols}")
[ $# -eq 0 ] && TARGETS=(app caddy ols)
for t in ${TARGETS[@]+"${TARGETS[@]}"}; do
  echo "== bench: $t (VUS=$VUS DURATION=$DURATION) =="
  bench_one "$t"
done
