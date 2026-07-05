# Open-source cache servers for tag-based invalidation: benchmarks & findings

Six open-source proxy stacks benchmarked as the HTTP cache layer for
[drizzle-page-cache](README.md): **Caddy + Souin**, **OpenLiteSpeed**,
**nginx**, **Angie**, **Varnish + Hitch**, and **Envoy** — three scenarios each
(cache hits, uncached passthrough, TLS handshake stress), plus the bugs and
footguns found along the way. Everything is reproducible from this repo: the
harness is [`e2e/bench.sh`](e2e/bench.sh), the exact server configs are in
[`e2e/`](e2e/), and the purge loop the tag-capable caches passed is
[`e2e/verify.sh`](e2e/verify.sh).

> **Scope honesty:** numbers come from one machine (6-vCPU Docker VM on Apple
> Silicon, 8 k6 VUs × 30 s per scenario, ~150 B pages) and are only comparable
> **within a run** — treat them as ratios, not absolutes. Run-to-run jitter on
> the C-family servers is ±10%. Tiny pages isolate proxy overhead; on realistic
> 20–90 KB pages, bandwidth narrows the gaps.

## TL;DR

- **Cache hits:** OpenLiteSpeed, nginx, Angie, and Varnish are at statistical
  parity (~50–54k req/s, ~0.02–0.03 CPU-ms); Caddy+Souin trails at ~38k with ~2×
  the CPU. **Envoy's cache filter never served a single hit** (finding 6).
- **Uncached passthrough:** every proxy sits at direct-app parity. A review
  claiming "OLS is slow uncached" did not reproduce.
- **TLS full handshakes:** OpenLiteSpeed wins decisively — ~35% more
  handshakes/s at ~40% less CPU than the OpenSSL/Go/hitch cluster; Envoy is
  slowest despite also using BoringSSL.
- **OpenLiteSpeed is the only open-source server combining native cache tags,
  built-in auto-HTTPS (v1.9+), TLS-flood protection by default, and nginx-class
  speed.** Costs: batched (seconds-delayed) purges, GUI-first docs,
  acme.sh-orchestrated rather than in-process ACME.
- Six bugs/footguns found and documented below — several upstream-issue-worthy.

## The comparison

|                             | **OpenLiteSpeed**                         | **Angie**                      | **Caddy + Souin**               | **nginx**                    | **Varnish + Hitch**            | **Envoy**                       |
| --------------------------- | ----------------------------------------- | ------------------------------ | ------------------------------- | ---------------------------- | ------------------------------ | ------------------------------- |
| License                     | GPLv3¹                                    | BSD-2                          | Apache-2.0                      | BSD-2                        | BSD-2 (both)                   | Apache-2.0                      |
| Install                     | official image/repos                      | official image/repos           | **custom xcaddy build**         | everywhere                   | two official images            | official image                  |
| Auto-HTTPS                  | ✅ built-in acme.sh orchestration (v1.9+) | ✅ native in-process ACME      | ✅ best-in-class, zero config   | ⚠️ preview module or certbot | ⚠️ hitch has no ACME (certbot) | ❌ (BYO cert / SDS)             |
| Tag purging                 | ✅ **native** (`X-LiteSpeed-Tag/-Purge`)  | ❌ URL + wildcard purge module | ✅ Surrogate-Key API²           | ❌ (NGINX-Plus-only)         | ✅ xkey vmod + bans            | ❌ **no purge of any kind**     |
| Purge latency               | seconds (batched)                         | immediate                      | immediate                       | —                            | immediate                      | —                               |
| Cache hits (req/s @ CPU-ms) | 50.6k @ 0.028                             | 53.7k @ 0.019                  | 38.5k @ 0.050                   | 51.0k @ 0.027                | 50.4k @ 0.028                  | **n/a — never hit** (finding 6) |
| TLS handshakes/s @ CPU-ms   | **6,294 @ 0.23**                          | 4,578 @ 0.39                   | 4,666 @ 0.39                    | 4,519 @ 0.40                 | 4,524 @ 0.43                   | 3,946 @ 0.49                    |
| Proxy idle RAM              | 34 MB                                     | ~21 MB                         | ~21 MB                          | ~16 MB                       | ~107 MB + hitch                | ~60 MB                          |
| Purge loop e2e in this repo | ✅ passing                                | bench only                     | ✅ passing (Deno/Node/Bun apps) | bench only                   | bench only³                    | impossible                      |

¹ GPLv3 imposes nothing on operators (running a server is not distribution); it
matters only when redistributing modified server binaries. ² Requires building
with `darkweak/souin/plugins/caddy` and a patched JSON config — findings 1
and 2. ³ `varnishPurger` (xkey) exists in the package; the e2e pairing exercises
caching only.

## Results (single run, 5 Jul 2026)

### Scenario 1 — cache hits (`/post/3`, warmed)

CPU is cgroup `usage_usec` deltas summed across proxy **and** app containers, ÷
completed requests.

| target                | req/s                                             | p50 (ms) | p95 (ms) | CPU-ms/req |
| --------------------- | ------------------------------------------------- | -------- | -------- | ---------- |
| direct app (no cache) | 11,162                                            | 0.59     | 1.03     | 0.091      |
| Caddy + Souin (otter) | 38,468                                            | 0.15     | 0.37     | 0.050      |
| Varnish               | 50,430                                            | 0.10     | 0.27     | 0.028      |
| OpenLiteSpeed         | 50,589                                            | 0.10     | 0.27     | 0.028      |
| nginx                 | 50,957                                            | 0.11     | 0.27     | 0.027      |
| Angie                 | 53,653                                            | 0.10     | 0.26     | 0.019      |
| Envoy                 | _10,025 — passthrough; the filter cached nothing_ |          |          | _0.180_    |

The C-family cluster (OLS/nginx/Angie/Varnish) is within jitter of itself.
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
| Envoy                 | 11,906 | 0.54     | 0.167      | parity                                         |
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
| Envoy             | 3,946        | 0.92     | 0.495      | BoringSSL     |

OLS leads by ~35% — and Envoy trailing _despite BoringSSL_ shows the lead isn't
only the crypto library; per-connection setup cost matters. This scenario is the
TLS-handshake-flood resilience number: an attacker pays a ClientHello, you pay
an ECDSA signature (and see finding 4 for OLS's other answer to that attack).

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

3. **nginx/Angie: `proxy_cache_lock` + a `no-store` response = 5-second
   stalls.** With a single cached `location`, the lock admits one request to
   "populate the cache"; a `no-store` response populates nothing, so every
   waiter eats the full `proxy_cache_lock_timeout` (5 s default). Measured: 2.6k
   req/s with p50 0.29 ms but max 5,008 ms. Fix (idiomatic): a cache-free
   `location` for known-uncacheable prefixes. OLS, Souin, Varnish, and Envoy
   handle uncacheable responses gracefully without config help.

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

6. **Envoy's HTTP cache filter (SimpleHttpCache) never served a hit in our
   setup** — verified on v1.33 and v1.35, with `cache_filter:trace` logging:
   every request runs a lookup, misses, fetches upstream, and inserts; the next
   identical request (same worker, same connection, textbook-cacheable 200 with
   `Cache-Control: public, max-age=300`, `Date`, `Content-Length`) misses again.
   Under load the "cache-hit" scenario equals passthrough (10.0k vs 11.9k req/s
   at the same CPU). Whatever the root cause, the filter also documents **no
   purge/invalidation mechanism whatsoever**, so it cannot participate in
   tag-based invalidation regardless. Not a candidate.

## Conclusions

- **Want tags + auto-HTTPS + speed in one open-source binary → OpenLiteSpeed.**
  Native tag purging at C-family hit rates, the fastest TLS handshakes,
  handshake-flood protection by default, built-in ACME since 1.9, 34 MB idle.
  Trade-offs: purges are batched (seconds of eventual consistency — fine under a
  TTL-backstop model), docs are GUI-first, ACME is orchestrated acme.sh rather
  than in-process.
- **Want nginx dialect + immediate purges → Angie.** Consistently the fastest
  hit path, in-process ACME, official purge/keyval modules — but invalidation is
  URL-shaped (this package's `angiePurger` maps tags → URL patterns).
- **Want the simplest ops story and can spare ~25% throughput → Caddy + Souin.**
  Best TLS automation and a real Surrogate-Key API — budget for the custom build
  and findings 1–2.
- **Want predicate invalidation (bans) or xkey tags at C speed → Varnish**, and
  accept two processes (hitch for TLS, no ACME in either) and the VCL learning
  curve. Hit-path parity with nginx measured here.
- **nginx** is the reference with no invalidation story in open source.
- **Envoy** is an excellent proxy and a non-starter as a page cache (finding 6):
  the cache filter is unreliable and has no invalidation. Use it for what it's
  for; put the cache elsewhere.

## Reproduce

```sh
cd e2e
./gen-certs.sh              # shared ECDSA cert for the TLS scenario
./gen-caddy-json.sh         # regenerate the patched caddy.json (needs built image)
docker compose up -d --build
./bench.sh                  # all targets × all scenarios → bench-results/
./verify.sh caddy && ./verify.sh ols   # the tag-purge loops
docker compose down
```

Methodology: k6 runs in Docker on the compose network; CPU from cgroup v2
`usage_usec` deltas across each target's containers; memory from
`memory.current`/`memory.peak`; tuning parity documented in
[`e2e/bench.sh`](e2e/bench.sh) (all cores everywhere, in-memory cache storage —
tmpfs `/dev/shm` for nginx/Angie/OLS, malloc for Varnish, otter for Souin —
upstream keepalive, logs off where possible). Related: the
[HotSauce vs WordPress report](https://claude.ai/code/artifact/9f7db1ca-3954-4dec-9143-94f0dd478540)
that seeded this methodology.
