/** A tag-aware cache (or CDN) that can evict entries by tag. */
export interface Purger {
  /** Called with a deduplicated batch of tags after writes settle/commit. */
  purge(tags: readonly string[]): Promise<void>;
}

export type Handler = (req: Request) => Promise<Response> | Response;

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
  /** Called when a purge batch fails. Default: console.error. TTL is the backstop. */
  onPurgeError?: (error: unknown, tags: readonly string[]) => void;
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
