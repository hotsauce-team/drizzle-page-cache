# drizzle-page-cache

Tag-based HTTP page-cache invalidation for
[Drizzle ORM](https://orm.drizzle.team) apps.

Put any Drizzle app behind a tag-aware HTTP cache (OpenLiteSpeed, Caddy/Souin,
Varnish xkey, Fastly — or URL-purge proxies like Angie/nginx) and get
**automatic, event-driven invalidation**: cache tags are derived from the
queries each request actually executes, emitted as a `Surrogate-Key` response
header, and purged when writes touch the same tables or rows.

- **Zero dependencies** (peer: `drizzle-orm`). Web-standard `Request`/`Response`
  only.
- **No SQL parsing.** Tags derive structurally from query builders and their
  results.
- **Runtime-agnostic**: Deno, Node, Bun (Cloudflare Workers needs
  `nodejs_compat` for `AsyncLocalStorage`).
- **Fails safe**: anything unrecognized over-tags — an unnecessary purge costs
  one re-render; a missed tag would serve stale content, so that direction never
  happens.

## Quickstart

```ts
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createPageCache } from "@hotsauce/drizzle-page-cache/souin";

const pageCache = createPageCache({
  schema,
  ttl: 3600, // s-maxage, the backstop — tags do the real invalidation
  site: "http://localhost", // Souin's PURGE API lives at /souin-api/souin
});

const db = pageCache.wrap(drizzle(client, { schema }));

// your server — Hono, plain Deno.serve, anything (Request) => Response
export default { fetch: pageCache.middleware(app.fetch) };
```

Every cacheable response (by default: `GET`, 2xx, path not under `/admin`) now
carries:

```
Surrogate-Key: posts:7 users
Cache-Control: max-age=0, s-maxage=3600, stale-while-revalidate=30
```

`max-age=0` is deliberate: browsers can't be purged, so only _shared_ caches
hold pages.

When a write executes — `db.update(posts).set(...).where(eq(posts.id, 7))` — the
matching tags (`posts:7`, `posts`) are purged automatically, batched and
deduplicated, and (inside `db.transaction`) held until commit, dropped on
rollback.

## Tag model

| Query                                   | Tags on the response         | Purged by              |
| --------------------------------------- | ---------------------------- | ---------------------- |
| single row by PK/unique equality (hit)  | `posts:7`                    | update/delete of row 7 |
| single row by PK/unique equality (miss) | `posts:7` + `posts`          | any write to `posts`   |
| list / filtered / ordered reads         | `posts`                      | any write to `posts`   |
| joins & relational `with`               | tags for each table involved | writes to either table |
| anything unrecognized                   | `*`                          | every purge            |

Escape hatches for pages the wrapper can't see through (raw SQL, computed
pages):

```ts
pageCache.tag("posts:7"); // add a tag to the current request
pageCache.purgeTags("posts"); // trigger a purge manually
```

## Purgers

Each supported cache has a directory entrypoint — drizzle-adapter style — that
wires its purger from a `site` URL: `drizzle-page-cache/litespeed`
(OpenLiteSpeed, see below), `/souin` (Caddy cache-handler), `/varnish` (xkey),
`/angie` (nginx-family wildcard URL purge, see below). For anything else, use
the root `createPageCache` with a purger — built in: `litespeedPurger`,
`souinPurger`, `varnishPurger`, `angiePurger`, `webhookPurger` — or implement
`Purger` (one method) for your CDN.

### LiteSpeed / OpenLiteSpeed

OpenLiteSpeed (GPLv3) has native tag support with its own dialect: a different
tag header, its own cache-control header, and **header-driven purging** (the
purge instruction rides a backend response _through_ the proxy). Use the
dedicated entrypoint — drizzle-adapter style — which derives the whole dialect
from three inputs:

```ts
import { createPageCache } from "drizzle-page-cache/litespeed";

const pageCache = createPageCache({
  schema,
  site: "https://example.com", // the proxy's PUBLIC base URL
  token: PURGE_TOKEN,
  ttl: 300, // drives s-maxage AND X-LiteSpeed-Cache-Control together
});
```

One `token` guards both halves of the purge loop (the middleware's echo route
and the purger that fetches it **via the proxy** — a purge header the proxy
never sees purges nothing); one `site` keeps their paths in agreement; one `ttl`
keeps the two cache-control headers coherent; and the `*` wildcard is renamed
automatically (a literal `*` purge flushes LiteSpeed's **entire** cache — the
entrypoint refuses it). The dialect-controlled options (`header`,
`headerSeparator`, `cacheHeaders`, `wildcardTag`, `purge`, `purgeEcho`) are
rejected at compile time; for a custom setup, use the root `createPageCache`
with those options explicitly:

<details>
<summary>What the entrypoint configures (expanded reference)</summary>

```ts
createPageCache({
  schema,
  purge: litespeedPurger(
    "https://example.com/__drizzle-page-cache/purge",
    token,
  ),
  header: "X-LiteSpeed-Tag",
  headerSeparator: ",",
  cacheHeaders: { "X-LiteSpeed-Cache-Control": "public, max-age=300" },
  wildcardTag: "dpc-wild",
  purgeEcho: { token },
});
```

</details>

Note OpenLiteSpeed batches purges internally, so eviction is
eventually-consistent by a few seconds. Working OLS server config in `e2e/ols/`.

### nginx-family (Angie / free nginx): URL wildcard purging

The nginx family has no open-source tag support, but its cache-purge module
accepts a trailing `*` — so the angie entrypoint maps each tag to URL patterns
you declare and purges by prefix instead:

```ts
import { createPageCache } from "drizzle-page-cache/angie";

const pageCache = createPageCache({
  schema,
  site: "http://angie",
  routes: { posts: ["/", "/post/*"] }, // a write to posts clears the list + every post page
});
```

**Building the `routes` object.** Keys are tags, values are the URL patterns to
PURGE when that tag is invalidated. A purged tag is looked up in three steps —
the exact tag (`"posts:7"`), then its table (`"posts"`, everything before the
`:`), then the `"*"` fallback — and the first match wins; tags matching no entry
are skipped. In practice **one key per table (plus one per manual tag you emit)
is all you need**: row tags like `posts:7` fall back to the `posts` entry
anyway, because URL purging can't hit a single row's pages any more precisely
than their shared prefix. For each table, list every page whose content depends
on it — index/list pages as exact paths, detail pages as a prefix wildcard:

```ts
routes: {
  // pages that render posts: the list pages exactly, the detail pages by prefix
  posts: ["/", "/blog", "/post/*"],
  // users appear on their profile pages AND inside every post page
  users: ["/author/*", "/post/*"],
  // a MANUAL tag (pageCache.tag("settings")) — the exact-tag step in action;
  // don't enumerate row tags like "posts:7" (the table key covers them)
  settings: ["/", "/about"],
  // fallback for any other manual/unknown tags; omit to skip them
  "*": ["/*"],
},
```

A trailing `*` purges every cache entry sharing that prefix (query-string
variants included); a path without `*` purges exactly one entry. Over-listing is
safe — an unnecessary purge costs one re-render; a missing pattern serves stale
pages until the TTL backstop expires.

Know the limitations before choosing this route:

- **Free nginx can't do this out of the box — you must bundle your own purge
  module.** Native `proxy_cache_purge` is NGINX-Plus-only, and no official
  open-source nginx package ships any purge module: you have to compile
  [`ngx_cache_purge`](https://github.com/nginx-modules/ngx_cache_purge) into
  your own nginx build (`--add-module`/`--add-dynamic-module`). **Angie ships
  that same module as an official prebuilt package** (preinstalled in its Docker
  image) — the practical choice if you won't maintain custom nginx binaries.
- **The wildcard is a trailing-`*` prefix match on the cache key — nothing
  more.** No mid-pattern globs, no regex; design your URL space so related pages
  share a purgeable prefix.
- **`proxy_cache_key` must be declared explicitly, variable part last** (e.g.
  `$uri$is_args$args`). Left at the implicit default, caching works but every
  PURGE silently returns 412 — see
  [BENCHMARKS.md finding 6](BENCHMARKS.md#findings-the-part-worth-citing).
- **Purging is coarser than tags**: a write to one row evicts the whole matching
  prefix (query-string variants included) — an over-purge, which is the safe
  direction, but budget the re-renders.

Working server config in `e2e/nginx/angie.conf`; the write → wildcard-purge loop
is verified by `e2e/verify.sh angie`.

Is it fast? See **[BENCHMARKS.md](BENCHMARKS.md)** — five open-source cache
stacks measured (hits, uncached passthrough, TLS handshakes) with the bugs we
found on the way, and `e2e/bench.sh` to rerun everything locally. Short version:
OLS sits at statistical parity with Varnish, Angie, and nginx on cache hits
while being the only one with native tags, and leads TLS full handshakes by
~35%.

## Observability

Quiet by default, except the two signals that can mean stale pages: **purge
failures** (`console.error` — your purge endpoint is down, TTL is now the only
backstop) and **unobserved writes** (`console.warn` — a write the facade
couldn't attribute to a table, so tagged pages won't be purged by it).

For everything else, supply `onEvent` (it then receives ALL events and the
default logging is disabled):

```ts
onEvent: (e) => {
  // 'wildcard-tag'      a read was opaque → over-purging (safe); deduped by reason
  // 'unobserved-write'  a write was opaque → possible staleness (fix these)
  // 'purge-batch'       what was purged, when — debugging gold
  // 'purge-error'       purger threw
  // 'header-overflow'   row tags collapsed to table tags (safe)
  logger.info(e);
},
```

**Debugging staleness locally**: set `debug: true` to expose the computed tags
as `X-Cache-Tags` on every response (including uncacheable/excluded paths), and
log `purge-batch` — together they answer "why did(n't) this page refresh." Never
enable `debug` in production; it leaks schema names.

## Namespacing (`tagPrefix`)

Running several apps or drizzle instances behind one shared cache/CDN? Without
namespacing, both apps tagging `posts` would purge each other's pages. A prefix
is applied to every tag — derived, manual, and the `*` wildcard bucket — and to
every purge, so reads and purges always agree:

```ts
createPageCache({ schema, purge, tagPrefix: "shop_" });
// → Surrogate-Key: shop_posts:7 shop_users   · purges: shop_posts:7 shop_posts
```

Prefer a non-`:` separator (like `shop_`) so tag→table mapping in purgers keeps
working. Note: shared-table multi-tenancy usually needs **no** prefix — row tags
are already globally unique, and table-tag purges crossing tenants only
over-purge, which is the safe direction. Per-request (dynamic) prefixes are a
possible future addition if per-tenant table tags ever matter.

## Status

v0.1 — core mechanism with the test matrix in `tests/`. See `SPEC.md` for the
full design, verified constraints of drizzle-orm 0.45.x, and the roadmap (nested
relation tags, Upstash `Cache` composition); see `BENCHMARKS.md` for the
five-stack cache comparison and findings. The e2e purge loop in `e2e/` passes on
**OpenLiteSpeed** (header-driven purging via the litespeed entrypoint's
`purgeEcho` + `litespeedPurger`), on **Caddy/Souin** — same app on Deno, Node
24, and Bun (the Node entry is a ~40-line `node:http` adapter, Bun needs none,
and only the demo's sqlite backend differs per runtime) — and on **Angie**
(wildcard URL purging via the angie entrypoint + the official cache-purge
module); Varnish + Hitch and nginx are benchmark-only pairings.
`cd e2e && ./verify.sh all` runs the whole sweep with live step output and a
PASS/FAIL summary.
