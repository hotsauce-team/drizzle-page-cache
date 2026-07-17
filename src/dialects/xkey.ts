/**
 * xkey dialect entrypoint — the canonical Varnish-family tag-purge factory —
 * drizzle-adapter style:
 *
 * ```ts
 * import { createPageCache } from "@hotsauce/drizzle-page-cache/xkey";
 *
 * const pageCache = createPageCache({
 *   schema,
 *   site: "http://localhost", // the proxy's base URL
 *   ttl: 3600,
 * });
 * ```
 *
 * Wires `varnishPurger`: one PURGE request to `site` carrying the tags in an
 * `xkey` header. This is the dialect Varnish's xkey vmod speaks — imported
 * by product name via `@hotsauce/drizzle-page-cache/varnish`, a thin re-export of this
 * module. Requires the xkey vmod and a VCL snippet handling PURGE
 * (`xkey.purge(req.http.xkey)`). For a custom purger, drop down to the root
 * `createPageCache`.
 *
 * Tags ride an `xkey` RESPONSE header too: on `import xkey;` the vmod
 * registers keys from the `xkey` (or `X-HashTwo`) backend-response header —
 * it never reads `Surrogate-Key`, so the default header would leave every
 * object keyless and every purge silently matching nothing. The header name
 * and separator are therefore dialect-controlled and rejected at compile
 * time.
 */

import { createPageCache as createCorePageCache } from "../page_cache.ts";
import { normalizeSite, varnishPurger } from "../purgers.ts";
import type { PageCache, PageCacheOptions } from "../types.ts";

/** Keys the xkey dialect controls — not accepted by this entrypoint. */
type ControlledKeys = "purger" | "header" | "headerSeparator";

export interface XkeyPageCacheOptions
  extends Omit<PageCacheOptions, ControlledKeys> {
  /** The proxy's base URL the PURGE is sent to, e.g. `http://localhost`. */
  site: string;
}

export function createPageCache(options: XkeyPageCacheOptions): PageCache {
  const { site, ...rest } = options;
  return createCorePageCache({
    ...rest,
    // vmod-xkey registers keys from the `xkey` backend-response header only;
    // the default Surrogate-Key is never read and no purge would ever match.
    header: "xkey",
    headerSeparator: " ",
    purger: varnishPurger(normalizeSite(site)),
  });
}

export type { PageCache } from "../types.ts";
