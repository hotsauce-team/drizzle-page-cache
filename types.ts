/** A tag-aware cache (or CDN) that can evict entries by tag. */
export interface Purger {
  /** Called with a deduplicated batch of tags after writes settle/commit. */
  purge(tags: readonly string[]): Promise<void>;
}

export type Handler = (req: Request) => Promise<Response> | Response;

/**
 * Structured observability events. Silent by default except:
 * `purge-error` (console.error) and `unobserved-write` (console.warn) — the
 * two that can mean stale pages. Supplying `onEvent` takes over ALL events.
 */
export type PageCacheEvent =
  /** A read was opaque to the facade → wildcard tag (over-purging, safe).
   * Deduplicated by `reason` for the lifetime of the instance. */
  | { kind: "wildcard-tag"; reason: string }
  /** A write was opaque to the facade → its purge only reaches the wildcard
   * bucket, so properly-tagged pages may go stale until TTL. The dangerous
   * direction — fix with `purgeTags()` or a recognizable statement. */
  | { kind: "unobserved-write"; reason: string }
  /** A purge batch was handed to the purger (debug-level). */
  | { kind: "purge-batch"; tags: readonly string[] }
  /** The purger threw; the TTL is now the only backstop. */
  | { kind: "purge-error"; tags: readonly string[]; error: unknown }
  /** A response's tag set exceeded `maxHeaderBytes` and row tags were
   * collapsed to table tags (over-tagging, safe). */
  | { kind: "header-overflow"; count: number; path: string };

export interface PageCacheOptions {
  /** Your drizzle schema — source of table names, PKs, and relations. */
  schema: Record<string, unknown>;
  purge: Purger;
  /** Shared-cache TTL in seconds (`s-maxage`). The backstop, not the mechanism. Default 3600. */
  ttl?: number;
  /** `stale-while-revalidate` in seconds. Default 30. */
  staleWhileRevalidate?: number;
  /** Response header carrying the tags. Default 'Surrogate-Key'. */
  header?: string;
  /** Path prefixes never tagged/cached. Default ['/admin']. */
  exclude?: string[];
  /** Full override of the cacheability predicate. */
  shouldTag?: (req: Request, res: Response) => boolean;
  /** Debounce window for purge batching, ms. Default 50. */
  settleMs?: number;
  /**
   * Prefix applied verbatim to every tag — derived, manual, wildcard — and to
   * every purge, so reads and purges always agree. Use it to namespace
   * multiple apps/drizzle instances sharing one cache (e.g. `'shop_'` →
   * `shop_posts:7`). Prefer a non-`:` separator so purger table-mapping
   * fallbacks keep working. Shared-table multi-tenancy usually does NOT need
   * this: row tags are already globally unique; table-tag purges cross
   * tenants, which only over-purges (safe).
   */
  tagPrefix?: string;
  /** Observability hook — see {@link PageCacheEvent}. Replaces the default
   * console logging for purge-error / unobserved-write when supplied. */
  onEvent?: (event: PageCacheEvent) => void;
  /** Collapse row tags to table tags when the header would exceed this many
   * bytes (some proxies reject large headers). Default 7900. */
  maxHeaderBytes?: number;
  /** Dev only: also expose tags as `X-Cache-Tags` on every response that has
   * them (including excluded paths). Leaks schema names — never in prod. */
  debug?: boolean;
}

export interface PageCache {
  /** Wrap a drizzle db (or transaction) instance. Same API in, same API out. */
  wrap<TDb>(db: TDb): TDb;
  /** Wrap your server handler: opens the request scope, stamps headers. */
  middleware(handler: Handler): Handler;
  /** Manually add tags to the current request (raw SQL, computed pages). */
  tag(...tags: string[]): void;
  /** Manually schedule a purge (CMS hooks, cron, admin tooling). */
  purgeTags(...tags: string[]): void;
  /** Flush any pending purge batch immediately (mainly for tests/shutdown). */
  flush(): Promise<void>;
}
