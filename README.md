# drizzle-page-cache

Tag-based HTTP page-cache invalidation for
[Drizzle ORM](https://orm.drizzle.team) apps.

Put any Drizzle app behind a tag-aware HTTP cache (Caddy/Souin, Varnish xkey,
Fastly — or URL-purge proxies like Angie/nginx) and get **automatic,
event-driven invalidation**: cache tags are derived from the queries each
request actually executes, emitted as a `Surrogate-Key` response header, and
purged when writes touch the same tables or rows.

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
import { createPageCache, souinPurger } from "@hotsauce/drizzle-page-cache";

const pageCache = createPageCache({
  schema,
  ttl: 3600, // s-maxage, the backstop — tags do the real invalidation
  purge: souinPurger("http://localhost/souin-api/souin"),
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

Built in: `souinPurger` (Caddy cache-handler), `varnishPurger` (xkey),
`angiePurger` (tag → URL-pattern wildcard PURGE for nginx-family proxies),
`litespeedPurger` (see below), `webhookPurger`. Or implement `Purger` (one
method) for your CDN.

### LiteSpeed / OpenLiteSpeed

OpenLiteSpeed (GPLv3) has native tag support, but purging is **header-driven**:
the purge instruction must ride a backend response _through_ the proxy rather
than hit a purge endpoint. Three options cover it:

```ts
createPageCache({
  schema,
  purge: litespeedPurger("http://your-site/__drizzle-page-cache/purge", token),
  header: "X-LiteSpeed-Tag",
  headerSeparator: ",",
  cacheHeaders: { "X-LiteSpeed-Cache-Control": "public, max-age=300" },
  wildcardTag: "dpc-wild", // REQUIRED: a literal `*` purge flushes EVERYTHING
  purgeEcho: { token }, // middleware serves the purge-echo route
});
```

`purgeEcho` makes the middleware serve a token-guarded route whose response
carries `X-LiteSpeed-Purge`; `litespeedPurger` fetches it **via the proxy's
public URL** (never the app directly — a purge header the proxy doesn't see
purges nothing). Note OpenLiteSpeed batches purges internally, so eviction is
eventually-consistent by a few seconds. Working OLS config in `e2e/ols/`.

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
relation tags, Upstash `Cache` composition). The e2e purge-loop harness in
`e2e/` runs the same app on **Deno, Node 24, and Bun** behind Caddy/Souin — the
Node entry is a ~40-line `node:http` adapter, Bun needs none (`Bun.serve` speaks
`Request`/`Response`), and only the demo's sqlite backend differs per runtime
(Bun ships `bun:sqlite`, not `node:sqlite`).
