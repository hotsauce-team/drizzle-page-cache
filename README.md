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
`webhookPurger`. Or implement `Purger` (one method) for your CDN.

## Status

v0.1 — core mechanism with the test matrix in `tests/`. See `SPEC.md` for the
full design, verified constraints of drizzle-orm 0.45.x, and the roadmap (nested
relation tags, Upstash `Cache` composition). e2e purge-loop harness in `e2e/`.
