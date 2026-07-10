/**
 * LiteSpeed / OpenLiteSpeed entrypoint — drizzle-adapter style:
 *
 * ```ts
 * import { createPageCache } from "@hotsauce/drizzle-page-cache/litespeed";
 *
 * const pageCache = createPageCache({
 *   schema,
 *   site: "https://example.com", // the proxy's PUBLIC base URL
 *   token: PURGE_TOKEN,
 *   ttl: 300,
 * });
 * ```
 *
 * LiteSpeed's dialect needs six options that must agree with each other
 * (tag header + separator, its own cache-control header, a wildcard rename —
 * a literal `*` purge flushes the ENTIRE cache — and header-driven purging
 * via a purge-echo route sharing one token and path with the purger). This
 * factory derives all of them from `site`, `token`, and `ttl`, and its
 * option type rejects the dialect-controlled keys at compile time. For a
 * custom setup, drop down to the root `createPageCache` — the expanded
 * form is documented in the README's LiteSpeed section.
 */

import { createPageCache as createCorePageCache } from "../page_cache.ts";
import { DEFAULT_PURGE_ECHO_PATH, litespeedPurger } from "../purgers.ts";
import type { PageCache, PageCacheOptions } from "../types.ts";

/** Keys the LiteSpeed dialect controls — not accepted by this entrypoint. */
type ControlledKeys =
  | "purge"
  | "header"
  | "headerSeparator"
  | "cacheHeaders"
  | "wildcardTag"
  | "purgeEcho";

export interface LiteSpeedPageCacheOptions
  extends Omit<PageCacheOptions, ControlledKeys> {
  /** The proxy's PUBLIC base URL (purges must flow THROUGH LiteSpeed),
   * e.g. `https://example.com` — no trailing slash, no path. */
  site: string;
  /** Shared secret guarding the purge-echo route. */
  token: string;
  /** Replacement for the `*` wildcard tag. Default 'dpc-wild'. Never `*`. */
  wildcardTag?: string;
}

export function createPageCache(options: LiteSpeedPageCacheOptions): PageCache {
  const { site, token, wildcardTag, ...rest } = options;
  const ttl = rest.ttl ?? 3600;
  const base = site.replace(/\/+$/, "");
  if (wildcardTag === "*") {
    throw new Error(
      "@hotsauce/drizzle-page-cache/litespeed: wildcardTag must not be '*' — a literal '*' purge flushes LiteSpeed's entire cache",
    );
  }

  return createCorePageCache({
    ...rest,
    ttl,
    // One `ttl` drives BOTH the standard s-maxage and LiteSpeed's own header.
    cacheHeaders: { "X-LiteSpeed-Cache-Control": `public, max-age=${ttl}` },
    header: "X-LiteSpeed-Tag",
    headerSeparator: ",",
    wildcardTag: wildcardTag ?? "dpc-wild",
    // One `site` + one `token` wire both halves of header-driven purging.
    purge: litespeedPurger(`${base}${DEFAULT_PURGE_ECHO_PATH}`, token),
    purgeEcho: { token },
  });
}

export type { PageCache } from "../types.ts";
