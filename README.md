# drizzle-page-cache

Tag-based HTTP page-cache invalidation for
[Drizzle ORM](https://orm.drizzle.team) apps.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtimes: Deno · Node · Bun](https://img.shields.io/badge/runtimes-Deno%20%C2%B7%20Node%20%C2%B7%20Bun-lightgrey.svg)](#installation)

Put any Drizzle app behind a tag-aware HTTP cache (OpenLiteSpeed, Caddy/Souin,
Varnish xkey, Fastly — or plain nginx/Angie made tag-aware by this package's Lua
helper) and get **automatic, event-driven invalidation**: cache tags are derived
from the queries each request actually executes, emitted as a `Surrogate-Key`
response header, and purged when writes touch the same tables or rows.

- **Zero dependencies** (peer: `drizzle-orm`). Web-standard `Request`/`Response`
  only.
- **No SQL parsing.** Tags derive structurally from query builders and their
  results.
- **Runtime-agnostic**: Deno, Node, Bun (Cloudflare Workers needs
  `nodejs_compat` for `AsyncLocalStorage`).
- **Fails safe**: anything unrecognized over-tags — an unnecessary purge costs
  one re-render; a missed tag would serve stale content, so that direction never
  happens.

**Contents:** [Installation](#installation) · [Quickstart](#quickstart) ·
[Tag model](#tag-model) · [Purgers](#purgers) · [Observability](#observability)
· [Namespacing](#namespacing-tagprefix) · [Development](#development) ·
[Status](#status) · [License](#license)

## Installation

```bash
# Deno
deno add jsr:@hotsauce/drizzle-page-cache

# Node / Bun
npm install drizzle-page-cache
```

`drizzle-orm` (>=0.44 <1) is a peer dependency — you already have it. Nothing
else is pulled in.

Works on Deno, Node ≥ 18, and Bun. Cloudflare Workers needs the
[`nodejs_compat`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
flag (for `AsyncLocalStorage`). Code samples below use the npm specifier
`drizzle-page-cache/...`; on Deno/JSR the same entrypoints live under
`@hotsauce/drizzle-page-cache/...`.

## Quickstart

```ts
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createPageCache } from "drizzle-page-cache/souin";

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
wires its purger from a `site` URL. Entrypoints are named by **wire dialect**,
with product aliases for discoverability:

- `drizzle-page-cache/surrogate-key` — `Surrogate-Key` header + a `POST` purge
  endpoint (the wire shape of Fastly's batch purge API; also serves any CDN that
  accepts it). Product aliases: `/nginx` and `/angie` (nginx family made
  tag-aware by this package's Lua helper, see below).
- `drizzle-page-cache/xkey` — `xkey` header + `PURGE`. Product alias:
  `/varnish`.
- `drizzle-page-cache/souin` — Souin's API (Caddy cache-handler).
- `drizzle-page-cache/litespeed` — OpenLiteSpeed's header-driven dialect (see
  below).

For anything else, use the root `createPageCache` with a purger — built in:
`litespeedPurger`, `souinPurger`, `varnishPurger`, `nginxPurger`,
`webhookPurger` — or implement `Purger` (one method) for your CDN.

### Souin / Caddy

Souin is tag-native — there is nothing to add to the proxy except its purge
**API, which you must enable server-side**. In a Caddyfile:

```
{
  order cache before rewrite
  cache {
    ttl 300s
    api { souin }   # exposes the purge API at /souin-api/souin
  }
}
:80 {
  cache
  reverse_proxy your-app:8000
}
```

The entrypoint (`site`, plus `apiPath` — default `/souin-api/souin`) sends one
`PURGE` there with the tags in a `Surrogate-Key` header. If you drive Caddy by
its **JSON** config (API/`caddy adapt`) rather than a Caddyfile, the
cache-handler plugin needs the API turned on there too — see BENCHMARKS.md
findings 1–2 for the patched-JSON caveat. Working config: `e2e/Caddyfile`
(adapted to `e2e/caddy.json` by `gen-caddy-json.sh`); the write → tag-purge loop
is verified by `e2e/verify.sh caddy` (and `caddy-node`, `caddy-bun`).

### Varnish (xkey)

The entrypoint sends one `PURGE` to `site` with the tags in an `xkey` header, so
your VCL needs the **xkey vmod** and a PURGE handler:

```vcl
vcl 4.1;
import xkey;

sub vcl_recv {
  if (req.method == "PURGE") {
    # invalidate every object tagged with any key in the xkey header
    set req.http.n-purged = xkey.purge(req.http.xkey);
    return (synth(200, "Purged " + req.http.n-purged));
  }
}
```

Guard `PURGE` with an ACL in production — Varnish applies no auth to it.
**Caveat: this purge path is not exercised by the e2e suite.** Varnish is a
benchmark-only pairing here (`e2e/varnish/default.vcl` caches for the hit/TLS
benches but implements no xkey purging), so — unlike nginx/Angie/OLS/Souin —
there is no `verify.sh` proof of the write → purge loop against Varnish. The
purger and header shape are unit-tested (`tests/entrypoints_test.ts`), and the
VCL above is standard xkey usage, but validate it in your environment.

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

### nginx-family (free nginx / Angie): tag purging via Lua

Stock nginx has no tag support — this package ships
[`nginx/purge.lua`](nginx/purge.lua) to add it, so purging is exactly as
row-precise as on the tag-native proxies and there is nothing to declare:

```ts
import { createPageCache } from "drizzle-page-cache/nginx"; // or /angie — identical

const pageCache = createPageCache({
  schema,
  site: "http://nginx",
});
```

How it works: the middleware already stamps every cacheable response with its
tags (`Surrogate-Key: posts posts:3`). The Lua `log` phase records each cache
key's tags in a `lua_shared_dict` whenever nginx stores a response. A purge is
one `POST <site>/__dpc/purge` with the invalidated tags in a `Surrogate-Key`
header — the wire shape of Fastly's batch purge API — and later requests whose
recorded tags were purged set `$skip_cache` for `proxy_cache_bypass`, refreshing
the entry from upstream. The endpoint (its own nginx `location`) also serves
Fastly-style `POST /__dpc/purge/<tag>` and `POST /__dpc/purge_all` for curl and
ops tooling, with `PURGE` accepted as a method alias.

It runs on any nginx with lua-nginx-module — distro packages (Alpine
`nginx-mod-http-lua`, Debian/Ubuntu `libnginx-mod-http-lua`), OpenResty, or
Angie's official `angie-module-lua` — two `load_module` lines and two location
blocks (full config in the file header). No compiling.

Semantics worth knowing:

- **A purge marks entries stale rather than deleting them** — eviction happens
  on the next request (`X-Cache-Status: BYPASS`), not at purge time.
- **Unknown keys are refreshed, never trusted**: a cache key the shared dicts
  don't know (first sight, proxy restart, dict eviction) is fetched fresh and
  re-recorded — stale-proof even when a disk cache outlives a restart, at the
  cost of one upstream fetch. It reads `X-Cache-Status: MISS`, which to the
  client it is; `BYPASS` means exactly "a purge evicted this".
- **`proxy_cache_key` must be declared as `$uri$is_args$args`** — the Lua helper
  mirrors that exact key string.
- `proxy_hide_header Surrogate-Key` is fine (recommended in production — tags
  leak schema names): the log phase reads the upstream header, not the
  client-facing one.
- Purges only enter through the dedicated endpoint location — guard that one
  block with `allow`/`deny` and/or `set $dpc_purge_token "…"` (clients must then
  send a matching `X-Purge-Token`; the entrypoint's `purgeToken` option does).
  The e2e configs leave it open on purpose.

Working server configs in `e2e/nginx/nginx.conf` (Alpine nginx +
`nginx-mod-http-lua`, built by `e2e/Dockerfile.nginx`) and
`e2e/nginx/angie.conf` (Angie's lua module); the write → tag-purge loop —
including row precision (editing post 3 must NOT evict post 2) — is verified by
`e2e/verify.sh nginx` and `e2e/verify.sh angie`.

**Second flavor — the LiteSpeed dialect on plain nginx.** The sibling script
[`nginx/purge_litespeed.lua`](nginx/purge_litespeed.lua) speaks LSCache instead
of Surrogate-Key: it honors `X-LiteSpeed-Cache-Control` (public/max-age decides
what nginx stores and for how long), records `X-LiteSpeed-Tag` tags per cache
key, and executes `X-LiteSpeed-Purge` headers riding any response through the
proxy (`tag=…`, `url=…`, `*` — LiteSpeed has no PURGE verb). That makes plain
nginx a public-page-cache backend for anything written for LiteSpeed — including
WordPress with the
[LiteSpeed Cache plugin](https://wordpress.org/plugins/litespeed-cache/), and
this package's own `/litespeed` entrypoint, which the e2e suite runs against it
UNCHANGED (`e2e/verify.sh nginx-ls`; config in `e2e/nginx/nginx-ls.conf`). Scope
honesty vs a real LiteSpeed server: public cache only — no private/per-user
cache (private purges are ignored), no ESI (keep it off in LSCWP), no vary
beyond bypassing the `_lscache_vary` login cookie, no crawler.

Is it fast? See **[BENCHMARKS.md](BENCHMARKS.md)** — five open-source cache
stacks measured (hits, uncached passthrough, TLS handshakes) with the bugs we
found on the way, and `e2e/bench.sh` to rerun everything locally. Short version:
OLS, Varnish, Angie, and nginx sit at statistical parity on cache hits — with
the Lua tag transport active on the nginx family, so tag purging costs nothing
measurable — and OLS leads TLS full handshakes.

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

## Development

Deno-first repo; the npm package is generated from it by
[dnt](https://github.com/denoland/dnt).

```bash
deno task test        # unit test matrix (tests/)
deno task check       # typecheck all entrypoints
deno task build:npm   # build the npm package into ./npm

cd e2e && ./verify.sh all   # full write → tag-purge sweep against real proxies
cd e2e && ./bench.sh        # rerun the BENCHMARKS.md measurements
```

The e2e suite needs Docker; it brings the proxy stack up and down itself
(`e2e/docker-compose.yml`). Issues and PRs welcome — a failing test or a
`verify.sh` transcript is the fastest way to get a bug fixed.

## License

[MIT](LICENSE) © Hotsauce Team
