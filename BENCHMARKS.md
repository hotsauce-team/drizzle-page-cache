# Open-source cache servers for tag-based invalidation: benchmarks & findings

Five open-source proxy stacks benchmarked as the HTTP cache layer for
[drizzle-page-cache](README.md): **OpenLiteSpeed**, **Caddy + Souin**,
**Varnish + Hitch**, **Angie**, and **nginx** — three scenarios each (cache
hits, uncached passthrough, TLS handshake stress), plus the bugs and footguns
found along the way. Everything is reproducible from this repo: the harness is
[`e2e/bench.sh`](e2e/bench.sh), the exact server configs are in [`e2e/`](e2e/),
and the purge loop the invalidation-capable stacks pass — OpenLiteSpeed,
Caddy/Souin, and Angie (wildcard URL purging) — is
[`e2e/verify.sh`](e2e/verify.sh).

> **Scope honesty:** numbers come from one machine (6-vCPU Docker VM on Apple
> Silicon, 8 k6 VUs × 30 s per scenario, ~150 B pages) and are only comparable
> **within a run** — treat them as ratios, not absolutes. Run-to-run jitter on
> the C-family servers is ±10%. Tiny pages isolate proxy overhead; on realistic
> 20–90 KB pages, bandwidth narrows the gaps.

## TL;DR

- **Cache hits:** OpenLiteSpeed, Varnish, Angie, and nginx are at statistical
  parity (~50–54k req/s, ~0.02–0.03 CPU-ms); Caddy+Souin trails at ~38k with ~2×
  the CPU.
- **Uncached passthrough:** every proxy sits at direct-app parity. A review
  claiming "OLS is slow uncached" did not reproduce.
- **TLS full handshakes:** OpenLiteSpeed wins decisively — ~35% more
  handshakes/s at ~40% less CPU than the OpenSSL/Go/hitch cluster.
- **OpenLiteSpeed is the only open-source server combining native cache tags,
  built-in auto-HTTPS (v1.9+), TLS-flood protection by default, and nginx-class
  speed.** Costs: batched (seconds-delayed) purges, GUI-first docs,
  acme.sh-orchestrated rather than in-process ACME.
- Six bugs/footguns found and documented below — several upstream-issue-worthy.

## The comparison

|                             | **OpenLiteSpeed**                         | **Caddy + Souin**               | **Varnish + Hitch**            | **Angie**                           | **nginx**                    |
| --------------------------- | ----------------------------------------- | ------------------------------- | ------------------------------ | ----------------------------------- | ---------------------------- |
| License                     | GPLv3¹                                    | Apache-2.0                      | BSD-2 (both)                   | BSD-2                               | BSD-2                        |
| Install                     | official image/repos                      | **custom xcaddy build**         | two official images            | official image/repos                | everywhere                   |
| Auto-HTTPS                  | ✅ built-in acme.sh orchestration (v1.9+) | ✅ best-in-class, zero config   | ⚠️ hitch has no ACME (certbot) | ✅ native in-process ACME           | ⚠️ preview module or certbot |
| Tag purging                 | ✅ **native** (`X-LiteSpeed-Tag/-Purge`)  | ✅ Surrogate-Key API²           | ✅ xkey vmod + bans            | ❌ URL + wildcard purge (module³)   | ❌ (Plus-only; or module³)   |
| Purge latency               | seconds (batched)                         | immediate                       | immediate                      | immediate                           | immediate (with module³)     |
| Cache hits (req/s @ CPU-ms) | 50.6k @ 0.028                             | 38.5k @ 0.050                   | 50.4k @ 0.028                  | 53.7k @ 0.019                       | 51.0k @ 0.027                |
| TLS handshakes/s @ CPU-ms   | **6,294 @ 0.23**                          | 4,666 @ 0.39                    | 4,524 @ 0.43                   | 4,578 @ 0.39                        | 4,519 @ 0.40                 |
| Proxy idle RAM              | 34 MB                                     | ~21 MB                          | ~107 MB + hitch                | ~21 MB                              | ~16 MB                       |
| Purge loop e2e in this repo | ✅ passing                                | ✅ passing (Deno/Node/Bun apps) | bench only⁴                    | ✅ **passing (wildcard URL purge)** | bench only                   |

¹ GPLv3 imposes nothing on operators (running a server is not distribution); it
matters only when redistributing modified server binaries. ² Requires building
with `darkweak/souin/plugins/caddy` and a patched JSON config — findings 1
and 2. ³ The same community module either way: Angie packages
[`ngx_cache_purge`](https://github.com/nginx-modules/ngx_cache_purge) as its
official prebuilt `angie-module-cache-purge` (preinstalled in the official
Docker image); **free nginx ships no purge at all** — native `proxy_cache_purge`
is NGINX-Plus-only, so open-source nginx needs that third-party module compiled
in yourself. Wildcard purging is a trailing-`*` prefix match on the cache key —
see finding 6 for the config it requires. ⁴ `varnishPurger` (xkey) exists in the
package; the e2e pairing exercises caching only.

## Results (single run, 5 Jul 2026)

### Scenario 1 — cache hits (`/post/3`, warmed)

CPU is cgroup `usage_usec` deltas summed across proxy **and** app containers, ÷
completed requests.

| target                | req/s  | p50 (ms) | p95 (ms) | CPU-ms/req |
| --------------------- | ------ | -------- | -------- | ---------- |
| direct app (no cache) | 11,162 | 0.59     | 1.03     | 0.091      |
| Caddy + Souin (otter) | 38,468 | 0.15     | 0.37     | 0.050      |
| Varnish               | 50,430 | 0.10     | 0.27     | 0.028      |
| OpenLiteSpeed         | 50,589 | 0.10     | 0.27     | 0.028      |
| nginx                 | 50,957 | 0.11     | 0.27     | 0.027      |
| Angie                 | 53,653 | 0.10     | 0.26     | 0.019      |

The C-family cluster (OLS/Varnish/Angie/nginx) is within jitter of itself.
Caddy's gap is Souin's Go middleware chain: Caddy serving a static file with no
cache module caps at ~31k, so Souin+otter already runs at ~90% of Caddy's own
ceiling (and otter matters: Souin's default in-memory store manages only ~2.6k
req/s — 10× from one build flag).

### Scenario 2 — uncached passthrough (`/admin/uncached`, `no-store`, verified uncached)

Same DB work as a detail page; the harness asserts the route is not cached
before measuring.

| target                | req/s  | p50 (ms) | CPU-ms/req | vs direct                                      |
| --------------------- | ------ | -------- | ---------- | ---------------------------------------------- |
| direct app (baseline) | 14,375 | 0.46     | 0.070      | —                                              |
| Angie                 | 12,458 | 0.51     | 0.115      | parity                                         |
| nginx                 | 11,942 | 0.53     | 0.127      | parity                                         |
| Caddy + Souin         | 11,769 | 0.56     | 0.120      | parity                                         |
| OpenLiteSpeed         | 11,099 | 0.60     | 0.138      | ~95% — "OLS slow uncached": **not reproduced** |
| Varnish               | 10,282 | 0.64     | 0.223      | ~90%                                           |

The app render (~0.5 ms) is the bottleneck; every proxy adds ≤0.18 ms p50.

### Scenario 3 — TLS full-handshake stress

Fresh connection per request (k6 `noConnectionReuse`), HTTP/1.1 pinned
(`GODEBUG=http2client=0`), one shared self-signed **ECDSA P-256** cert
everywhere ([`gen-certs.sh`](e2e/gen-certs.sh); RSA is ~10× dearer and would
swamp the result), session cache **and** tickets disabled on every server — full
handshakes verified with `openssl s_client`, 0% failed requests. rps = full
handshakes/second. Varnish terminates no TLS; its row is **hitch** (6 workers —
the default is ONE) speaking PROXY protocol to Varnish.

| target            | handshakes/s | p50 (ms) | CPU-ms/req | TLS library   |
| ----------------- | ------------ | -------- | ---------- | ------------- |
| **OpenLiteSpeed** | **6,294**    | **0.27** | **0.233**  | **BoringSSL** |
| Caddy             | 4,666        | 0.35     | 0.386      | Go            |
| Angie             | 4,578        | 0.37     | 0.392      | OpenSSL       |
| Hitch → Varnish   | 4,524        | 0.60     | 0.427      | OpenSSL       |
| nginx             | 4,519        | 0.38     | 0.403      | OpenSSL       |

OLS leads by ~35% — and not only because of the crypto library; per-connection
setup cost matters. This scenario is the TLS-handshake-flood resilience number:
an attacker pays a ClientHello, you pay an ECDSA signature (and see finding 4
for OLS's other answer to that attack).

## Findings (the part worth citing)

1. **`caddyserver/cache-handler` has broken surrogate-key purging.** It lags the
   Souin upstream; purges return 204 and do nothing. Build with
   `github.com/darkweak/souin/plugins/caddy` instead. (Community-reported;
   reproduced here.)

2. **The Souin API cannot be enabled from a Caddyfile at all.** The Caddy
   plugin's `FromApp` merges TTL/storages/verbs from the global cache app into
   the handler config but never copies `API`, and the Caddyfile parser rejects
   `api` at site level ("must be global") — so `PURGE
   /souin-api/souin`
   silently falls through to your app. Workaround: adapt to JSON and patch
   `Configuration.API.souin.enable: true`
   ([`e2e/gen-caddy-json.sh`](e2e/gen-caddy-json.sh)). Upstream-issue-worthy.

3. **Angie/nginx: `proxy_cache_lock` + a `no-store` response = 5-second
   stalls.** With a single cached `location`, the lock admits one request to
   "populate the cache"; a `no-store` response populates nothing, so every
   waiter eats the full `proxy_cache_lock_timeout` (5 s default). Measured: 2.6k
   req/s with p50 0.29 ms but max 5,008 ms. Fix (idiomatic): a cache-free
   `location` for known-uncacheable prefixes. OLS, Souin, and Varnish handle
   uncacheable responses gracefully without config help.

4. **OpenLiteSpeed ships TLS-handshake-flood protection ON by default.** Past
   ~200 new SSL connections/s from one client IP it logs "possible SSL
   negotiation based attack, block!" and refuses connections. As a default,
   that's a resilience feature most servers don't have; for a single-IP bench it
   produced a fake-spectacular 13.9k "handshakes"/s that was 99.7% instant
   failures. Lifted via `perClientConnLimit` (marked BENCH ONLY in
   [`e2e/ols/httpd_config.conf`](e2e/ols/httpd_config.conf)). Lesson encoded in
   the harness: `bench.sh` warns loudly whenever >1% of requests fail.

5. **Hitch defaults to a single worker.** `--workers=1` unless told otherwise —
   a parity trap for any multi-core TLS comparison (first probe: 2.9k
   handshakes/s at p50 1.5 ms; 4.5k after `--workers=6`).

6. **Angie's cache-purge module silently no-ops without an explicit
   `proxy_cache_key`.** With `proxy_cache_purge PURGE from ...` in the caching
   location and the key left at nginx's implicit default
   (`$scheme$proxy_host$request_uri`), caching works normally but **every**
   PURGE — exact or wildcard — returns `412 Precondition Failed` and evicts
   nothing. Declare the key explicitly (e.g. `$uri$is_args$args`, the key
   Angie's own module docs use) and both purge forms work; the variable part
   must sit at the **end** of the key or trailing-`*` wildcard purges won't
   prefix-match. One adjacent trap: 412 (not 404) is the module's default "not
   in cache" answer (`cache_purge_legacy_status`), so purgers must treat both as
   success — `angiePurger` does. (`Vary` responses are a non-issue: with an
   explicit key the module purged Vary'd entries fine.) Verified config:
   [`e2e/nginx/angie.conf`](e2e/nginx/angie.conf); the wildcard purge loop
   (write to one row evicts every `/post/*` entry, query-string variants
   included) is asserted by [`e2e/verify.sh`](e2e/verify.sh)&nbsp;`angie`.

## Conclusions

- **Want tags + auto-HTTPS + speed in one open-source binary → OpenLiteSpeed.**
  Native tag purging at C-family hit rates, the fastest TLS handshakes,
  handshake-flood protection by default, built-in ACME since 1.9, 34 MB idle.
  Trade-offs: purges are batched (seconds of eventual consistency — fine under a
  TTL-backstop model), docs are GUI-first, ACME is orchestrated acme.sh rather
  than in-process.
- **Want the simplest ops story and can spare ~25% throughput → Caddy + Souin.**
  Best TLS automation and a real Surrogate-Key API — budget for the custom build
  and findings 1–2.
- **Want predicate invalidation (bans) or xkey tags at C speed → Varnish**, and
  accept two processes (hitch for TLS, no ACME in either) and the VCL learning
  curve. Hit-path parity with nginx measured here.
- **Want nginx dialect + immediate purges → Angie.** Consistently the fastest
  hit path, in-process ACME, official purge/keyval modules — but invalidation is
  URL-shaped (this package's `angiePurger` maps tags → URL patterns; the full
  write → wildcard-purge loop is verified by `e2e/verify.sh angie`, and finding
  6 documents the `proxy_cache_key` footgun it requires you to avoid).
- **nginx** is the reference with no invalidation in the official open-source
  build: native `proxy_cache_purge` is NGINX-Plus-only, and free nginx ships no
  purge module — you must compile in the same community `ngx_cache_purge` module
  that Angie packages officially (which is Angie's practical edge here).

## Reproduce

```sh
cd e2e
./gen-certs.sh              # shared ECDSA cert for the TLS scenario
./gen-caddy-json.sh         # regenerate the patched caddy.json (needs built image)
docker compose up -d --build
./bench.sh                  # all targets × all scenarios → bench-results/
./verify.sh all             # every purge loop, live steps + PASS/FAIL summary
docker compose down
```

Methodology: k6 runs in Docker on the compose network; CPU from cgroup v2
`usage_usec` deltas across each target's containers; memory from
`memory.current`/`memory.peak`; tuning parity documented in
[`e2e/bench.sh`](e2e/bench.sh) (all cores everywhere, in-memory cache storage —
tmpfs `/dev/shm` for OLS/Angie/nginx, malloc for Varnish, otter for Souin —
upstream keepalive, logs off where possible).
