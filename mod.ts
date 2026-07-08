/**
 * drizzle-page-cache — tag-based HTTP page-cache invalidation for Drizzle apps.
 *
 * Derives cache tags from the queries a request executes, emits them as a
 * `Surrogate-Key` header (+ `Cache-Control` with `s-maxage`), and purges the
 * matching tags when writes touch the same tables/rows.
 *
 * See README.md for the tag model and SPEC.md for the design.
 */

export { createPageCache } from "./page_cache.ts";
export {
  litespeedPurger,
  nginxPurger,
  souinPurger,
  varnishPurger,
  webhookPurger,
} from "./purgers.ts";
export { WILDCARD } from "./derive.ts";
export type {
  Handler,
  PageCache,
  PageCacheEvent,
  PageCacheOptions,
  Purger,
} from "./types.ts";
