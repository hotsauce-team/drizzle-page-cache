/**
 * Varnish (xkey vmod) entrypoint — drizzle-adapter style:
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
 *
 * Wires `varnishPurger`: one PURGE request to `site` carrying the tags in an
 * `xkey` header. Requires the xkey vmod and a VCL snippet handling PURGE
 * (`xkey.purge(req.http.xkey)`). For a custom purger, drop down to the root
 * `createPageCache`.
 */

import { createPageCache as createCorePageCache } from "../page_cache.ts";
import { varnishPurger } from "../purgers.ts";
import type { PageCache, PageCacheOptions } from "../types.ts";

export interface VarnishPageCacheOptions
  extends Omit<PageCacheOptions, "purge"> {
  /** The proxy's base URL the PURGE is sent to, e.g. `http://localhost`. */
  site: string;
}

export function createPageCache(options: VarnishPageCacheOptions): PageCache {
  const { site, ...rest } = options;
  return createCorePageCache({
    ...rest,
    purge: varnishPurger(site.replace(/\/+$/, "")),
  });
}

export type { PageCache } from "../types.ts";
