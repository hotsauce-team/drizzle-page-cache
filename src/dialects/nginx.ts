/**
 * nginx entrypoint — the `@hotsauce/drizzle-page-cache/surrogate-key` factory under
 * the name nginx users will look for. Stock nginx has no tag support, so it
 * pairs with the Lua helper in `nginx/purge.lua` (this directory), which
 * makes the proxy tag-aware and serves the dedicated `/__dpc/` purge
 * endpoint. Requires lua-nginx-module (Alpine `nginx-mod-http-lua`,
 * Debian/Ubuntu `libnginx-mod-http-lua`, or OpenResty) — see the verified
 * config in `e2e/nginx/nginx.conf` and the full dialect docs on
 * `./surrogate-key.ts`.
 *
 * Purge marks self-size: every purge carries
 * `X-DPC-Mark-TTL: ttl + staleWhileRevalidate`, so there is no mark
 * lifetime to configure or keep in sync in the nginx config.
 *
 * ```ts
 * import { createPageCache } from "@hotsauce/drizzle-page-cache/nginx";
 *
 * const pageCache = createPageCache({
 *   schema,
 *   site: "http://localhost",
 *   ttl: 3600,
 * });
 * ```
 */

export { createPageCache } from "./surrogate-key.ts";
export type { SurrogateKeyPageCacheOptions as NginxPageCacheOptions } from "./surrogate-key.ts";
export type { PageCache } from "../types.ts";
