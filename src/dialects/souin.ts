/**
 * Souin entrypoint (Caddy cache-handler, or Souin anywhere else) —
 * drizzle-adapter style:
 *
 * ```ts
 * import { createPageCache } from "@hotsauce/drizzle-page-cache/souin";
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
 *
 * Souin parses `Surrogate-Key` as COMMA-separated (each key trimmed) — a
 * space-joined header is stored as ONE composite tag that no purge ever
 * matches, silently disabling tag invalidation. The header name and
 * separator are therefore dialect-controlled and rejected at compile time.
 */

import { createPageCache as createCorePageCache } from "../page_cache.ts";
import { normalizeSite, souinPurger } from "../purgers.ts";
import type { PageCache, PageCacheOptions } from "../types.ts";

/** Souin's default API endpoint path. */
export const DEFAULT_SOUIN_API_PATH = "/souin-api/souin";

/** Keys the Souin dialect controls — not accepted by this entrypoint. */
type ControlledKeys = "purger" | "header" | "headerSeparator";

export interface SouinPageCacheOptions
  extends Omit<PageCacheOptions, ControlledKeys> {
  /** The proxy's base URL, e.g. `http://localhost` — no trailing slash. */
  site: string;
  /** Souin API path on that host. Default `/souin-api/souin`. */
  apiPath?: string;
}

export function createPageCache(options: SouinPageCacheOptions): PageCache {
  const { site, apiPath, ...rest } = options;
  const base = normalizeSite(site);
  return createCorePageCache({
    ...rest,
    // Souin splits Surrogate-Key on commas (trimming each key); the default
    // space join would be stored as one composite tag — unpurgeable.
    header: "Surrogate-Key",
    headerSeparator: ", ",
    purger: souinPurger(`${base}${apiPath ?? DEFAULT_SOUIN_API_PATH}`),
  });
}

export type { PageCache } from "../types.ts";
