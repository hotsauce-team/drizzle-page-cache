# Open-source cache servers for tag-based invalidation: benchmarks & findings

Five open-source proxy stacks benchmarked as the HTTP cache layer for
[drizzle-page-cache](README.md): **OpenLiteSpeed**, **Caddy + Souin**,
**Varnish + Hitch**, **Angie**, and **nginx** — three scenarios each (cache
hits, uncached passthrough, TLS handshake stress), plus the bugs and footguns
found along the way. Everything is reproducible from this repo: the harness is
[`e2e/bench.sh`](e2e/bench.sh), the exact server configs are in [`e2e/`](e2e/),
and the purge loop the invalidation-capable stacks pass — OpenLiteSpeed,
Caddy/Souin, Angie, and nginx (tag purging via this package's Lua helper) — is
[`e2e/verify.sh`](e2e/verify.sh).

> **Scope honesty:** numbers come from one machine (6-vCPU Docker VM on Apple
> Silicon, 8 k6 VUs × 30 s per scenario, ~150 B pages) and are only comparable
> **within a run** — treat them as ratios, not absolutes. Run-to-run jitter on
> the C-family servers is ±10%. Tiny pages isolate proxy overhead; on realistic
> 20–90 KB pages, bandwidth narrows the gaps.

## TL;DR

- **Cache hits:** OpenLiteSpeed, Varnish, Angie, and nginx are at statistical
  parity (~47–52k req/s, ~0.02–0.03 CPU-ms); Caddy+Souin trails at ~38k with ~2×
  the CPU.
- **The Lua tag transport is free at this precision:** Angie and nginx run the
  full `purge.lua` rewrite/log phases on every request in these numbers and
  still sit in the C-family cluster — tag purging costs nothing measurable on
  the hit path.
- **Uncached passthrough:** the app render is the bottleneck; every proxy adds
  ≤0.21 ms p50. A review claiming "OLS is slow uncached" did not reproduce.
- **TLS full handshakes:** OpenLiteSpeed wins — 6.3k/s at the lowest CPU;
  Alpine's nginx build follows at 5.4k; the OpenSSL/Go/hitch cluster sits at
  ~4.5k.
- **OpenLiteSpeed is the only open-source server combining native cache tags,
  built-in auto-HTTPS (v1.9+), TLS-flood protection by default, and nginx-class
  speed.** Costs: batched (seconds-delayed) purges, GUI-first docs,
  acme.sh-orchestrated rather than in-process ACME.
- Six bugs/footguns found and documented below — several upstream-issue-worthy.

## The comparison

|                             | **OpenLiteSpeed**                         | **Caddy + Souin**               | **Varnish + Hitch**            | **Angie**                      | **nginx**                    |
| --------------------------- | ----------------------------------------- | ------------------------------- | ------------------------------ | ------------------------------ | ---------------------------- |
| License                     | GPLv3¹                                    | Apache-2.0                      | BSD-2 (both)                   | BSD-2                          | BSD-2                        |
| Install                     | official image/repos                      | **custom xcaddy build**         | two official images            | official image/repos           | everywhere                   |
| Auto-HTTPS                  | ✅ built-in acme.sh orchestration (v1.9+) | ✅ best-in-class, zero config   | ⚠️ hitch has no ACME (certbot) | ✅ native in-process ACME      | ⚠️ preview module or certbot |
| Tag purging                 | ✅ **native** (`X-LiteSpeed-Tag/-Purge`)  | ✅ Surrogate-Key API²           | ✅ xkey vmod + bans            | ✅ via `nginx/purge.lua`³      | ✅ via `nginx/purge.lua`³    |
| Purge latency               | seconds (batched)                         | immediate                       | immediate                      | immediate                      | immediate                    |
| Cache hits (req/s @ CPU-ms) | 49.0k @ 0.028                             | 37.6k @ 0.049                   | 49.2k @ 0.028                  | 51.7k @ 0.024                  | 47.2k @ 0.028                |
| TLS handshakes/s @ CPU-ms   | **6,345 @ 0.23**                          | 4,579 @ 0.38                    | 4,490 @ 0.42                   | 4,594 @ 0.39                   | 5,402 @ 0.33                 |
| Proxy idle RAM              | 34 MB                                     | ~21 MB                          | ~107 MB + hitch                | ~21 MB                         | ~16 MB                       |
| Purge loop e2e in this repo | ✅ passing                                | ✅ passing (Deno/Node/Bun apps) | bench only⁴                    | ✅ **passing (Lua tag purge)** | ✅ passing (Lua tag purge)   |

¹ GPLv3 imposes nothing on operators (running a server is not distribution); it
matters only when redistributing modified server binaries. ² Requires building
with `darkweak/souin/plugins/caddy` and a patched JSON config — findings 1
and 2. ³ Not native — stock nginx has no tag concept (`proxy_cache_purge` is
NGINX-Plus-only and URL-based; Angie packages the community
[`ngx_cache_purge`](https://github.com/nginx-modules/ngx_cache_purge), also
URL-based — see finding 6 for its footgun). This package's `nginx/purge.lua`
adds real tag purging on any lua-nginx-module build (Alpine/Debian distro
packages, OpenResty, Angie's `angie-module-lua` — no compiling): the Lua log
phase records each cache key's `Surrogate-Key` tags in a shared dict, and a tag
purge (one POST to a dedicated, guardable endpoint) marks matching entries for
`proxy_cache_bypass` refresh. Both nginx-family pairings here run it. ⁴
`varnishPurger` (xkey) exists in the package; the e2e pairing exercises caching
only.

## Results (single run, 8 Jul 2026)

All numbers from one `./bench.sh` sweep. Angie and nginx run the Lua tag
transport (`nginx/purge.lua`) on every request — its rewrite/log phases are
included in their numbers.

### Scenario 1 — cache hits (`/post/3`, warmed)

CPU is cgroup `usage_usec` deltas summed across proxy **and** app containers, ÷
completed requests.

| target                | req/s  | p50 (ms) | p95 (ms) | CPU-ms/req |
| --------------------- | ------ | -------- | -------- | ---------- |
| direct app (no cache) | 11,564 | 0.58     | 0.91     | 0.088      |
| Caddy + Souin (otter) | 37,598 | 0.15     | 0.36     | 0.049      |
| nginx (+ purge.lua)   | 47,170 | 0.12     | 0.27     | 0.028      |
| OpenLiteSpeed         | 49,039 | 0.11     | 0.28     | 0.028      |
| Varnish               | 49,222 | 0.11     | 0.27     | 0.028      |
| Angie (+ purge.lua)   | 51,722 | 0.10     | 0.26     | 0.024      |

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
| direct app (baseline) | 14,340 | 0.46     | 0.070      | —                                              |
| nginx                 | 13,535 | 0.49     | 0.110      | ~94%                                           |
| Angie                 | 13,064 | 0.50     | 0.115      | ~91%                                           |
| Caddy + Souin         | 12,567 | 0.53     | 0.111      | ~88%                                           |
| OpenLiteSpeed         | 11,735 | 0.57     | 0.132      | ~82% — "OLS slow uncached": **not reproduced** |
| Varnish               | 10,083 | 0.67     | 0.227      | ~70%                                           |

The app render (~0.5 ms) is the bottleneck; every proxy adds ≤0.21 ms p50.

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
| **OpenLiteSpeed** | **6,345**    | **0.26** | **0.227**  | **BoringSSL** |
| nginx (Alpine)    | 5,402        | 0.34     | 0.328      | OpenSSL       |
| Angie             | 4,594        | 0.36     | 0.387      | OpenSSL       |
| Caddy             | 4,579        | 0.35     | 0.380      | Go            |
| Hitch → Varnish   | 4,490        | 0.59     | 0.422      | OpenSSL       |

OLS leads — by ~17% over Alpine's nginx build, ~40% over the rest — and not only
because of the crypto library; per-connection setup cost matters. This scenario
is the TLS-handshake-flood resilience number: an attacker pays a ClientHello,
you pay an ECDSA signature (and see finding 4 for OLS's other answer to that
attack).

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
   success. (`Vary` responses are a non-issue: with an explicit key the module
   purged Vary'd entries fine.) This package has since moved the nginx family to
   the Lua tag transport (footnote ³), which sidesteps the module — but the
   explicit-key requirement stands: `nginx/purge.lua` mirrors
   `$uri$is_args$args` exactly. Verified config:
   [`e2e/nginx/angie.conf`](e2e/nginx/angie.conf); the tag purge loop —
   including row precision (editing post 3 must not evict post 2) — is asserted
   by [`e2e/verify.sh`](e2e/verify.sh)&nbsp;`angie`.

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
- **Want nginx dialect + immediate purges → Angie or plain nginx**, made
  tag-aware by this package's `nginx/purge.lua` (footnote ³): row-precise tag
  purging on the stock server, no purge module and no compiling — Angie via its
  official `angie-module-lua`, free nginx via a distro lua-nginx-module package.
  Angie adds in-process ACME and is consistently the fastest hit path.
  `e2e/verify.sh angie|nginx` verifies the loop, precision assertions included.

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
