/**
 * Angie entrypoint — the `drizzle-page-cache/surrogate-key` factory under
 * the name Angie users will look for. Angie runs the same `nginx/purge.lua`
 * tag transport through its official `angie-module-lua` package (bundled in
 * the full Docker image; load `ndk_http_module.so` first) — see the
 * verified config in `e2e/nginx/angie.conf` and the full dialect docs on
 * `../surrogate-key/mod.ts`.
 *
 * If you raise `ttl` past a day, also raise `$dpc_tag_ttl` in the Angie
 * config — purge marks self-expire after it (default 86400s) and it MUST
 * exceed your longest `ttl` + `staleWhileRevalidate`.
 *
 * ```ts
 * import { createPageCache } from "drizzle-page-cache/angie";
 *
 * const pageCache = createPageCache({
 *   schema,
 *   site: "http://localhost",
 *   ttl: 3600,
 * });
 * ```
 */

export { createPageCache } from "../surrogate-key/mod.ts";
export type { SurrogateKeyPageCacheOptions as AngiePageCacheOptions } from "../surrogate-key/mod.ts";
export type { PageCache } from "../types.ts";
