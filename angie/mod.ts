/**
 * Angie / nginx-family entrypoint (URL wildcard purging) — drizzle-adapter
 * style:
 *
 * ```ts
 * import { createPageCache } from "drizzle-page-cache/angie";
 *
 * const pageCache = createPageCache({
 *   schema,
 *   site: "http://localhost",
 *   routes: { posts: ["/", "/post/*"] }, // tag → URL patterns
 *   ttl: 3600,
 * });
 * ```
 *
 * The nginx family has no tag support, so `routes` maps each tag (or its
 * table prefix; `"*"` is the fallback for unknown tags) to URL patterns
 * purged via the cache-purge module. Know the dialect's limits:
 *
 * - the wildcard is a trailing-`*` PREFIX match on the cache key — nothing
 *   more, so purging is coarser than tags (an over-purge: safe, but budget
 *   the re-renders);
 * - the proxy MUST declare `proxy_cache_key` explicitly with the URI part
 *   last (e.g. `$uri$is_args$args`) or every PURGE silently returns 412 —
 *   see BENCHMARKS.md finding 6 and the verified config in
 *   `e2e/nginx/angie.conf`;
 * - free nginx needs the third-party `ngx_cache_purge` module compiled in;
 *   Angie ships it as an official package.
 *
 * For a custom purger, drop down to the root `createPageCache`.
 */

import { createPageCache as createCorePageCache } from "../page_cache.ts";
import { angiePurger } from "../purgers.ts";
import type { PageCache, PageCacheOptions } from "../types.ts";

export interface AngiePageCacheOptions extends Omit<PageCacheOptions, "purge"> {
  /** The proxy's base URL PURGE requests are sent to, e.g. `http://localhost`. */
  site: string;
  /** Tag (or table, or `"*"` fallback) → URL patterns, e.g.
   * `{ posts: ["/", "/post/*"] }`. A trailing `*` prefix-purges. */
  routes: Record<string, string[]>;
}

export function createPageCache(options: AngiePageCacheOptions): PageCache {
  const { site, routes, ...rest } = options;
  return createCorePageCache({
    ...rest,
    purge: angiePurger(site.replace(/\/+$/, ""), routes),
  });
}

export type { PageCache } from "../types.ts";
