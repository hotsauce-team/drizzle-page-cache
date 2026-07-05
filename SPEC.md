# Design spec

Tag-based HTTP page-cache invalidation for Drizzle apps. Standalone; zero
runtime dependencies (peer: `drizzle-orm`); Web-standard `Request`/`Response`;
Deno/Node/Bun (Workers via `nodejs_compat`).

## Verified constraints (drizzle-orm 0.45.1 — spiked, don't re-litigate)

1. **No public instrumentation API.** `Logger` is
   `(sql: string, params: unknown[])` only. No middleware/interceptor/hooks.
   `tracing.js` is an inert stub.
2. **The relational API (`db.query.*`) bypasses the `{ cache }` extension**:
   `query-builders/query.js` `_prepare()` passes `queryMetadata: void 0` and
   `session.js` `queryWithCache()` skips the cache when metadata is undefined.
   Upstream issue-worthy (structured `{ type, tables }` exists internally via
   `extractUsedTable()`, just not computed on the RQB path).
3. **`logger` sees RQB queries** (they compile to one statement) — strings only.
4. **Structured extraction is possible with exported API only**:
   `SQL.queryChunks` (public readonly), `Column` (`.name`, `.primary`,
   `.isUnique`), `Param` (`.value`), `getTableName()`, `getTableColumns()`.
   `eq(posts.id, 7)` walks as `[Column, StringChunk(' = '), Param]`.
5. **ALS gotcha**: `als.run(set, fn)` is synchronous; drizzle builders are lazy
   thenables. A query awaited _outside_ the scope tags nothing. Middleware
   always awaits inside; tests must too.
6. Row precision from PK-equality WHERE walking verified against a real CMS
   handler.

## Architecture

- **Interception: transparent facade** (`pageCache.wrap(db)`) over
  `select / insert / update / delete / query / transaction`. Drizzle's API
  passes through unchanged. Rejected alternatives: SQL-string parsing (fragile),
  the `{ cache }` slot (RQB gap; reserved for real cache users), logger (strings
  only).
- **Read tags derive from RESULTS, not query shape** (the Drupal model):
  returned rows contain PK values, so slug/unique lookups get row tags with no
  correlation machinery. Entity/list split:
  - _Entity read_ — exactly one row returned AND the WHERE contains an equality
    on the PK or a unique column → row tag only (`posts:7`). A detail page
    survives unrelated writes.
  - _Entity miss_ (0 rows, unique equality) → row tag **+** table tag, so
    creating the row later invalidates a cached 404.
  - _List read_ — anything else → table tag (`posts`). Joined / related tables
    add their table tags.
  - Partial selects that omit the PK degrade to the table tag.
- **Write purges from WHERE walking + statement type**: update/delete with PK
  equality → row tag + table tag; insert / non-PK writes → table tag. Writes by
  non-PK columns can't get row precision (result is a change count; injecting
  `.returning()` would alter user-visible result shapes — rejected).
- **Request scope**: `AsyncLocalStorage`, opened by
  `pageCache.middleware(handler)`.
- **Headers** (only when `shouldTag(req, res)` passes; default `GET` && 2xx &&
  path not excluded): `Surrogate-Key: <tags>` and
  `Cache-Control: max-age=0, s-maxage=<ttl>, stale-while-revalidate=<n>`.
  `max-age=0` is non-negotiable — browsers cannot be purged.
- **Purge queue**: deduplicated, debounced (`settleMs`); **transaction-aware** —
  mutations inside `db.transaction()` buffer and flush only on commit, dropped
  on rollback (purging pre-commit lets the proxy cache pre-commit data).
  Failures are logged; the TTL is the backstop (no retry queue in v0.x).
- **Escape hatches**: `tag(...tags)` and `purgeTags(...tags)`.
- **Observability** (`onEvent`, structured `PageCacheEvent`): quiet by default
  except `purge-error` (console.error) and `unobserved-write` (console.warn) —
  the two staleness-risk signals. `wildcard-tag` is deduplicated by reason
  (over-purging is safe; the event is developer feedback, not an alarm).
  `header-overflow` collapses row tags to table tags (safe direction) rather
  than truncating (unsafe). `debug: true` exposes `X-Cache-Tags` on all
  responses for local staleness debugging — never production. Drizzle's own
  `Logger` was considered and rejected as the channel: wrong interface
  (`logQuery(sql, params)` only) and reaching the configured instance requires
  internals access.
- **Namespacing** (`tagPrefix`, static string): applied verbatim to every tag
  (derived, manual, wildcard) and every purge at the two choke points, so reads
  and purges always agree. Solves cross-app collisions behind a shared
  cache/CDN. Shared-table multi-tenancy needs no prefix (row tags globally
  unique; cross-tenant table purges only over-purge). Dynamic per-request
  prefixes deliberately deferred — writes have no request context outside the
  ALS scope, so a correct implementation needs design work.

## Out of scope (v0.x)

- Upstash / `{ cache }` composition. When added: read tags must be recorded in
  `Cache.get` (fires on hits, receives `tables` pre-execution) because a
  DB-cache hit executes no query and the facade tap sees nothing.
- Nested relation row tags (RQB `with:` related rows → `users:3`) — v0.2; table
  tags for related tables already apply.
- Purge retry/persistence; multi-instance coordination.

## Acceptance tests (tests/)

Full matrix: PK read hit/miss, unique-column read, RQB findMany/findFirst, list
reads, partial selects, update/delete by PK, insert, joined reads, tx
commit/rollback buffering, concurrent-request ALS isolation, header hygiene (no
tags on POST / errors / excluded paths), the lazy-thenable regression.

## e2e (e2e/)

Caddy (xcaddy: `darkweak/souin/plugins/caddy` + otter storage, Souin API enabled
via patched JSON config) in front of the same app on **three runtimes**: a
shared runtime-neutral `app.ts` (drizzle + this package; sqlite backend
injected) with per-runtime entries — Deno (`Deno.serve` + `db-node.ts`), Node 24
(native type stripping; ~40-line `node:http` ↔ `Request`/`Response` adapter +
`db-node.ts`), and Bun (`Bun.serve`, no adapter, + `db-bun.ts`, container-only).
Bun has **no `node:sqlite`** (verified 1.3.14) — the split into `db-node.ts` /
`db-bun.ts` exists solely for that; the package itself is untouched. Loop:
render → HIT → write → purge → MISS with fresh body —
`./verify.sh caddy && ./verify.sh caddy-node && ./verify.sh caddy-bun`, all
three verified passing 5 Jul 2026. Fourth pairing: **OpenLiteSpeed** (GPLv3,
`e2e/ols/` config: backend-driven caching via `enableCache 0` +
`checkPublicCache 1`) with the same Deno app in litespeed mode
(`X-LiteSpeed-Tag`, comma separator, `X-LiteSpeed-Cache-Control`, `wildcardTag`
rename, purge-echo route + `litespeedPurger`) — `./verify.sh ols` passing 5 Jul
2026, including tag-purge of query-string variants and colon-containing tags.
Derived from the benchmarked configs in
https://claude.ai/code/artifact/9f7db1ca-3954-4dec-9143-94f0dd478540 (HotSauce
vs WordPress report: proxy throughput, purge modules, invalidation table).

**Local bench harness** (`e2e/bench.sh`, local-only, not CI): k6 in Docker
drives cache-hit traffic per target; CPU from cgroup v2 `usage_usec` deltas and
peak memory (`memory.peak`) summed across proxy + app containers. Targets
include bench-only nginx and Angie pairings (no tag purging), tuned for parity:
all cores (`worker_processes auto` / OLS `httpdWorkers`), in-memory cache
storage (tmpfs `/dev/shm` for nginx/angie/OLS; otter is in-memory by design),
upstream keepalive, logs off where possible.

Reference run (5 Jul 2026, Docker VM on Apple Silicon, 6 vCPU, 8 VUs × 30 s,
~150 B page — compare within one run only):

| target                | req/s | p50 (ms) | CPU-ms/req |
| --------------------- | ----- | -------- | ---------- |
| direct app (no cache) | 10.4k | 0.61     | 0.097      |
| Caddy + Souin (otter) | 37.3k | 0.15     | 0.051      |
| OpenLiteSpeed         | 48.3k | 0.11     | 0.028      |
| nginx                 | 49.4k | 0.11     | 0.021      |
| Angie                 | 48.2k | 0.10     | 0.024      |

nginx, Angie, and OLS are within ~2% on throughput — statistical parity — with
nginx cheapest per request and OLS close behind while being the only one of the
three with native tag purging. Caddy trails at ~76% throughput and ~2× CPU.

**TLS handshake stress** (`*-tls-hs`: fresh connection per request via k6
`noConnectionReuse`, HTTP/1.1 pinned with `GODEBUG=http2client=0` to avoid the
ALPN/h2 confound, one shared self-signed ECDSA P-256 cert everywhere
(`gen-certs.sh`), session cache AND tickets disabled on every server so each
connection pays a FULL handshake — verified with `openssl s_client`, 0% failed
requests). rps = full handshakes/second:

| target        | handshakes/s | p50 (ms) | CPU-ms/req | TLS library |
| ------------- | ------------ | -------- | ---------- | ----------- |
| OpenLiteSpeed | 6,151        | 0.27     | 0.238      | BoringSSL   |
| Angie         | 4,642        | 0.36     | 0.396      | OpenSSL     |
| nginx         | 4,593        | 0.37     | 0.396      | OpenSSL     |
| Caddy         | 4,568        | 0.36     | 0.385      | Go          |

BoringSSL (OLS) delivers ~34% more full handshakes/s at ~40% less CPU; Go and
OpenSSL are effectively tied. Two findings from the bring-up: (1) **OLS ships
TLS-handshake-flood protection ON by default** (~200 new SSL connections/s per
client IP → "possible SSL negotiation based attack, block!") — excellent for the
budget-VPS resilience story, fatal for a single-IP bench; lifted via
`perClientConnLimit` (marked BENCH ONLY in the config). Its first "result" was
99.7% silent failures, so `bench.sh` now prints a loud WARNING whenever a run's
failure rate exceeds 1%. (2) A Docker-VM clock jump can poison k6's `rate` (a
901 s "request" inside a 1 s iteration) — sanity-check `count/rate ≈ duration`
when a number looks absurd.

**Uncached passthrough** (`/admin/uncached`: same DB work, `no-store`, under the
excluded prefix; `bench.sh` asserts the route isn't cached before measuring).
Same run: direct app 11.4k req/s @ p50 0.49 ms · Caddy 12.3k @ 0.54 · OLS 11.0k
@ 0.59 · nginx 13.1k @ 0.50 · Angie 12.0k @ 0.51 — **every proxy is at
direct-app parity within run variance** (the app render is the bottleneck); OLS
adds ~0.1 ms p50, indistinguishable from the rest. The "OLS is slow at uncached"
claim did not reproduce. One real finding: with a single cached `location`,
**nginx/Angie `proxy_cache_lock` + a no-store response stalls waiting requests
for `proxy_cache_lock_timeout` (5 s default)** — measured as 2.6k req/s with p50
0.29 ms but max 5008 ms before the fix. Idiomatic fix (applied to the configs):
a cache-free `location` for known-uncacheable prefixes. OLS and Caddy/Souin
handle uncacheable responses gracefully without config help. Memory sums carry a
caveat: caddy/nginx/angie share the same `app` container (whose V8 heap grows
across earlier runs), so cross-target memory comparison is indicative only.
Measured proxy-only idle memory (cgroup `memory.current`, 30 s after one warmed
request): **OpenLiteSpeed 34 MB** with `httpdWorkers 6`; from the earlier
report's harness: nginx ~16 MB, Angie/Caddy ~21 MB, Varnish ~107 MB.

## Upstream issues to file

1. **drizzle-team/drizzle-orm**: RQB `_prepare` passes `queryMetadata: void 0`
   so `db.query.*` bypasses the cache layer; also consider exposing
   `queryMetadata` to `Logger`. Two independent use cases (query caching,
   cache-tag derivation) want the same seam.
2. **darkweak/souin** (found during e2e bring-up, both verified at source):
   - The Caddy plugin's `FromApp` merges TTL/storages/verbs from the global
     cache app into the handler config but **never copies `API`** — and the
     Caddyfile parser rejects `api` at site level ("must be global"), so the
     Souin API cannot be enabled from a Caddyfile at all. Workaround: run Caddy
     on adapted JSON with `Configuration.API.souin.enable` patched true (see
     `e2e/docker-compose.yml`).
   - `caddyserver/cache-handler` lags Souin upstream and has broken
     surrogate-key purging — build with
     `github.com/darkweak/souin/plugins/caddy` instead
     (https://caddy.community/t/-/30857).
