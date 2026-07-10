/**
 * Surrogate-Key dialect entrypoint — the canonical tag-purge factory —
 * drizzle-adapter style:
 *
 * ```ts
 * import { createPageCache } from "drizzle-page-cache/surrogate-key";
 *
 * const pageCache = createPageCache({
 *   schema,
 *   site: "http://localhost",
 *   ttl: 3600,
 * });
 * ```
 *
 * This is the dialect nginx, Angie, Fastly, and any CDN that accepts a
 * `Surrogate-Key` batch purge all speak — imported by product name via
 * `drizzle-page-cache/nginx` and `drizzle-page-cache/angie`, which are thin
 * re-exports of this module.
 *
 * The wire contract:
 *
 * - the middleware stamps every cacheable response with its tags
 *   (`Surrogate-Key: posts posts:3`);
 * - the purger sends one `POST <site>/__dpc/purge` with the invalidated
 *   tags in a `Surrogate-Key` header — the wire shape of Fastly's batch
 *   purge API. The endpoint also serves `POST /__dpc/purge/<tag>` and
 *   `POST /__dpc/purge_all` for curl/ops, and optionally requires an
 *   `X-Purge-Token`.
 *
 * On stock nginx/Angie the endpoint is supplied by the Lua helper in
 * `nginx/purge.lua`, which makes the proxy tag-aware:
 *
 * - the Lua log phase records each cache key's tags in a `lua_shared_dict`;
 * - later requests whose recorded tags were purged set `$skip_cache` for
 *   `proxy_cache_bypass`, refreshing the entry from upstream.
 *
 * So purging is row-precise, exactly like the tag-native proxies — no
 * tag → URL mapping to maintain. It runs on any nginx with
 * lua-nginx-module: distro packages (Alpine `nginx-mod-http-lua`,
 * Debian/Ubuntu `libnginx-mod-http-lua`), OpenResty, or Angie's official
 * `angie-module-lua`. No compiling. See the verified config in
 * `e2e/nginx/nginx.conf` and the header of `purge.lua`.
 *
 * Semantics worth knowing (nginx/Angie Lua backing):
 *
 * - a purge marks entries stale rather than deleting them: eviction
 *   happens on the next request (`X-Cache-Status: BYPASS`), not at purge
 *   time;
 * - a request whose cache key the Lua dicts don't know (first sight, or
 *   after a proxy restart / dict eviction) is fetched fresh and
 *   re-recorded — stale-proof even when a disk cache outlives a restart.
 *   It reads `X-Cache-Status: MISS`, which to the client it is; BYPASS
 *   means exactly "a purge evicted this";
 * - `proxy_cache_key` MUST be declared as `$uri$is_args$args` — `purge.lua`
 *   mirrors that exact key string.
 * - purge marks self-size: every purge from this entrypoint carries
 *   `X-DPC-Mark-TTL: ttl + staleWhileRevalidate`, so a mark lives exactly
 *   as long as the oldest page it may need to invalidate — nothing to keep
 *   in sync in the nginx/Angie config. Headerless purges (curl/ops) are
 *   remembered for 30 days, the Lua's cap.
 *
 * For a custom purger, drop down to the root `createPageCache`.
 */

import { createPageCache as createCorePageCache } from "../page_cache.ts";
import { nginxPurger } from "../purgers.ts";
import type { PageCache, PageCacheOptions } from "../types.ts";

export interface SurrogateKeyPageCacheOptions
  extends Omit<PageCacheOptions, "purge"> {
  /** The proxy's base URL purges are sent to, e.g. `http://localhost`. */
  site: string;
  /** Route of the purge endpoint location. Default `/__dpc/purge`. */
  purgePath?: string;
  /** Shared secret when the endpoint location sets `$dpc_purge_token`;
   * sent as `X-Purge-Token`. */
  purgeToken?: string;
}

export function createPageCache(
  options: SurrogateKeyPageCacheOptions,
): PageCache {
  const { site, purgePath, purgeToken, ...rest } = options;
  return createCorePageCache({
    ...rest,
    purge: nginxPurger(site.replace(/\/+$/, ""), {
      path: purgePath,
      token: purgeToken,
      // A mark must outlive every page it may need to invalidate; state
      // the page lifetime so the Lua sizes marks exactly (defaults mirror
      // page_cache.ts).
      markTtl: (rest.ttl ?? 3600) + (rest.staleWhileRevalidate ?? 30),
    }),
  });
}

export type { PageCache } from "../types.ts";
