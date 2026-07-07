/**
 * Souin entrypoint (Caddy cache-handler, or Souin anywhere else) —
 * drizzle-adapter style:
 *
 * ```ts
 * import { createPageCache } from "drizzle-page-cache/souin";
 *
 * const pageCache = createPageCache({
 *   schema,
 *   site: "http://localhost", // the proxy's base URL
 *   ttl: 3600,
 * });
 * ```
 *
 * Wires `souinPurger` against Souin's API endpoint (`site` + `apiPath`,
 * default `/souin-api/souin`) — the API must be enabled server-side
 * (`cache { api { souin } }`; for the Caddy plugin that requires a patched
 * JSON config, see BENCHMARKS.md findings 1–2). For a custom purger, drop
 * down to the root `createPageCache`.
 */

import { createPageCache as createCorePageCache } from "../page_cache.ts";
import { souinPurger } from "../purgers.ts";
import type { PageCache, PageCacheOptions } from "../types.ts";

/** Souin's default API endpoint path. */
export const DEFAULT_SOUIN_API_PATH = "/souin-api/souin";

export interface SouinPageCacheOptions extends Omit<PageCacheOptions, "purge"> {
  /** The proxy's base URL, e.g. `http://localhost` — no trailing slash. */
  site: string;
  /** Souin API path on that host. Default `/souin-api/souin`. */
  apiPath?: string;
}

export function createPageCache(options: SouinPageCacheOptions): PageCache {
  const { site, apiPath, ...rest } = options;
  const base = site.replace(/\/+$/, "");
  return createCorePageCache({
    ...rest,
    purge: souinPurger(`${base}${apiPath ?? DEFAULT_SOUIN_API_PATH}`),
  });
}

export type { PageCache } from "../types.ts";
