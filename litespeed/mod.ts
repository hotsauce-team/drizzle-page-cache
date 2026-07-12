/**
 * LiteSpeed / OpenLiteSpeed entrypoint — drizzle-adapter style:
 *
 * ```ts
 * import { createPageCache } from "drizzle-page-cache/litespeed";
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
 * (tag header + separator, its own cache-control header, a guard against
 * `*` as the bucket tag — a literal `*` purge flushes the ENTIRE cache —
 * and header-driven purging via a purge-echo route sharing one token and
 * path with the purger). This factory derives them from `site`, `token`,
 * and `ttl`, and its
 * option type rejects the dialect-controlled keys at compile time. For a
 * custom setup, drop down to the root `createPageCache` — the expanded
 * form is documented in the README's LiteSpeed section.
 */

import { createPageCache as createCorePageCache } from "../page_cache.ts";
import {
  DEFAULT_PURGE_ECHO_PATH,
  litespeedPurger,
  normalizeSite,
} from "../purgers.ts";
import type { PageCache, PageCacheOptions } from "../types.ts";

/** Keys the LiteSpeed dialect controls — not accepted by this entrypoint. */
type ControlledKeys =
  | "purger"
  | "header"
  | "headerSeparator"
  | "cacheHeaders"
  | "unknownTag"
  | "purgeEcho";

export interface LiteSpeedPageCacheOptions
  extends Omit<PageCacheOptions, ControlledKeys> {
  /** The proxy's PUBLIC base URL (purges must flow THROUGH LiteSpeed),
   * e.g. `https://example.com` — no trailing slash, no path. */
  site: string;
  /** Shared secret guarding the purge-echo route. */
  token: string;
  /** Wire name of the unknown-bucket tag. Default 'dpc-unknown'. Never `*`
   * — a literal `*` purge flushes LiteSpeed's ENTIRE cache. */
  unknownTag?: string;
}

export function createPageCache(options: LiteSpeedPageCacheOptions): PageCache {
  const { site, token, unknownTag, ...rest } = options;
  const ttl = rest.ttl ?? 3600;
  const base = normalizeSite(site);
  if (unknownTag === "*" || rest.allTag === "*") {
    throw new Error(
      "drizzle-page-cache/litespeed: unknownTag/allTag must not be '*' — a literal '*' purge flushes LiteSpeed's entire cache",
    );
  }

  return createCorePageCache({
    ...rest,
    ttl,
    // One `ttl` drives BOTH the standard s-maxage and LiteSpeed's own header.
    cacheHeaders: { "X-LiteSpeed-Cache-Control": `public, max-age=${ttl}` },
    header: "X-LiteSpeed-Tag",
    headerSeparator: ",",
    unknownTag,
    // One `site` + one `token` wire both halves of header-driven purging.
    purger: litespeedPurger(`${base}${DEFAULT_PURGE_ECHO_PATH}`, token),
    purgeEcho: { token },
  });
}

export type { PageCache } from "../types.ts";
