/**
 * Varnish entrypoint — the `drizzle-page-cache/xkey` factory under the name
 * Varnish users will look for. Wires `varnishPurger`: one PURGE request to
 * `site` carrying the tags in an `xkey` header. Requires the xkey vmod and a
 * VCL snippet handling PURGE (`xkey.purge(req.http.xkey)`) — see the full
 * dialect docs on `../xkey/mod.ts`.
 *
 * ```ts
 * import { createPageCache } from "drizzle-page-cache/varnish";
 *
 * const pageCache = createPageCache({
 *   schema,
 *   site: "http://localhost", // the proxy's base URL
 *   ttl: 3600,
 * });
 * ```
 */

export { createPageCache } from "../xkey/mod.ts";
export type { XkeyPageCacheOptions as VarnishPageCacheOptions } from "../xkey/mod.ts";
export type { PageCache } from "../types.ts";
