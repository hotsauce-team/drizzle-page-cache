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
- **Headers** (only when the safety gate passes — no `Set-Cookie`, no
  `private`/`no-store`/`no-cache` in `Cache-Control`; always enforced, the
  app's non-shareable signals win — AND the `shouldTag(req, res)` policy
  passes; default `GET` && 2xx, overridable to exclude paths or cache 404s):
  `Surrogate-Key: <tags>` and
  `Cache-Control: max-age=0, s-maxage=<ttl>, stale-while-revalidate=<n>`.
  `max-age=0` is non-negotiable — browsers cannot be purged.
- **Purge queue**: deduplicated, debounced (`settleMs`); **transaction-aware** —
  mutations inside `db.transaction()` buffer and flush only on commit, dropped
  on rollback (purging pre-commit lets the proxy cache pre-commit data).
  Failures are logged; the TTL is the backstop (no retry queue in v0.x).
- **Escape hatches**: `tag(...tags)` and `purgeBatch(...tags)` (join the
  settled batch, fire-and-forget); `purge(...tags)` / `purgeAll()` send
  immediately and REJECT on purger failure — deploy hooks get a real exit
  code where the batch path deliberately swallows (a purge failure must not
  crash request handling).
- **Reserved tags** (renameable; collision-checked against table names at
  init): `dpc-unknown` — stamped on opaque reads, carried by every purge
  batch, so unknown pages never outlive a write; `dpc-all` — stamped on every
  tagged response, never purged automatically, one `purgeAll()` flushes
  everything this cache tagged (release invalidation).
- **Observability** (`onEvent`, structured `PageCacheEvent`): quiet by default
  except `purge-error` (console.error) and `unobserved-write` (console.warn) —
  the two staleness-risk signals. `unobserved-read` is deduplicated by reason
  (over-purging is safe; the event is developer feedback, not an alarm).
  `header-overflow` collapses row tags to table tags (safe direction) rather
  than truncating (unsafe); if even table tags exceed the byte budget, the
  header degrades to the reserved tags — the bucket is purged on every
  write, so still safe. `debug: true` exposes `X-Cache-Tags` on all
  responses for local staleness debugging — never production. Drizzle's own
  `Logger` was considered and rejected as the channel: wrong interface
  (`logQuery(sql, params)` only) and reaching the configured instance requires
  internals access.
- **Dialect entrypoints** (drizzle-adapter style): a proxy dialect with
  _coupled_ options gets its own subpath export whose factory derives them from
  minimal inputs and whose option type `Omit`s the controlled keys (compile-time
  rejection). Rule: coupled invariants → entrypoint
  (`drizzle-page-cache/litespeed`: shared token/path, tag header + separator,
  ttl-coherent cache-control, `*` guard); a single `purger:` option → just
  a purger export (Souin/Varnish/Angie). The root `createPageCache` remains the
  escape hatch and the documented expanded form.
- **Namespacing** (`tagPrefix`, static string): applied verbatim to every tag
  (derived, manual, unknown bucket) and every purge at the two choke points, so
  reads
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
tags on POST / errors / safety-gated responses), the lazy-thenable regression.

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
(`X-LiteSpeed-Tag`, comma separator, `X-LiteSpeed-Cache-Control`, `unknownTag`
rename, purge-echo route + `litespeedPurger`) — `./verify.sh ols` passing 5 Jul
2026, including tag-purge of query-string variants and colon-containing tags.

**Benchmarks** — full results, methodology, tuning parity, and the
findings/footguns (Souin API bug, nginx cache-lock stalls, OLS TLS-flood
protection, Angie purge cache-key trap, hitch workers) live in
[BENCHMARKS.md](BENCHMARKS.md). Local-only harness: `e2e/bench.sh`.

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
