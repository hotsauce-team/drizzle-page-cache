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
  /** A read was opaque to the facade → unknown-bucket tag (over-purging, safe).
   * Deduplicated by `reason` for the lifetime of the instance. */
  | { kind: "unobserved-read"; reason: string }
  /** A write was opaque to the facade → its purge only reaches the unknown
   * bucket, so properly-tagged pages may go stale until TTL. The dangerous
   * direction — fix with `purge()`/`purgeBatch()` or a recognizable
   * statement. */
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
  /** The tag-aware cache/CDN purges are sent to — built in: `souinPurger`,
   * `varnishPurger`, `nginxPurger`, `litespeedPurger`, `webhookPurger`; or
   * implement {@link Purger} (one method). Dialect entrypoints wire this. */
  purger: Purger;
  /** Shared-cache TTL in seconds (`s-maxage`). The backstop, not the mechanism. Default 3600. */
  ttl?: number;
  /** `stale-while-revalidate` in seconds. Default 30. */
  staleWhileRevalidate?: number;
  /** Response header carrying the tags. Default 'Surrogate-Key'.
   * LiteSpeed/OpenLiteSpeed: 'X-LiteSpeed-Tag'. */
  header?: string;
  /** Separator between tags in the header. Default ' ' (Surrogate-Key style).
   * LiteSpeed expects ','. */
  headerSeparator?: string;
  /** Extra headers set verbatim on cacheable responses, e.g. LiteSpeed's
   * `{ 'X-LiteSpeed-Cache-Control': 'public, max-age=300' }`. */
  cacheHeaders?: Record<string, string>;
  /** Wire name of the unknown-bucket tag on both responses and purges.
   * Default 'dpc-unknown'. Must not equal a table name (checked at init).
   * Never a literal `*` on LiteSpeed — an `X-LiteSpeed-Purge: *` flushes
   * the entire cache. */
  unknownTag?: string;
  /** Wire name of the all-pages tag, stamped on every response the
   * middleware tags. Never purged automatically — `purgeAll()` purges it
   * (deploy/release invalidation). Default 'dpc-all'. Must not equal a
   * table name or `unknownTag` (checked at init). */
  allTag?: string;
  /**
   * Serve a purge-echo route from the middleware, for servers that purge via
   * response headers flowing THROUGH the proxy (LiteSpeed/OpenLiteSpeed)
   * instead of a purge endpoint. The matching `litespeedPurger` fetches this
   * route via the proxy; the response carries the purge header.
   */
  purgeEcho?: {
    /** Shared secret; requests without it get 403. */
    token: string;
    /** Route path. Default '/__drizzle-page-cache/purge'. */
    path?: string;
    /** Purge header name. Default 'X-LiteSpeed-Purge'. */
    header?: string;
    /** Header value builder. Default: tags → `tag=a, tag=b`. */
    value?: (tags: readonly string[]) => string;
  };
  /** Cacheability *policy* predicate. Default: `GET` && 2xx. Narrow it to
   * exclude paths (`(req, res) => req.method === "GET" && res.ok &&
   * !new URL(req.url).pathname.startsWith("/admin/")`) or widen it to cache
   * non-2xx (e.g. 404s — entity-miss tags already invalidate them on row
   * creation). A safety gate always applies on top and cannot be widened:
   * responses with `Set-Cookie` or `private`/`no-store`/`no-cache` in
   * `Cache-Control` are never tagged/cached, so personalized responses are
   * never promoted to a shared cache. */
  shouldTag?: (req: Request, res: Response) => boolean;
  /** Debounce window for purge batching, ms. Default 50. */
  settleMs?: number;
  /**
   * Prefix applied verbatim to every tag — derived, manual, unknown bucket —
   * and to
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
   * UTF-8 bytes (some proxies reject large headers); if even table tags
   * exceed it, the header degrades to the reserved tags (the bucket is
   * purged on every write — over-purged, never stale). Default 7900. */
  maxHeaderBytes?: number;
  /** Dev only: also expose tags as `X-Cache-Tags` on every response that has
   * them (including uncacheable ones). On cacheable responses it mirrors
   * the wire header exactly (`allTag`, overflow collapse and all);
   * elsewhere, the derived tags. Leaks schema names — never in prod. */
  debug?: boolean;
}

export interface PageCache {
  /** Wrap a drizzle db (or transaction) instance. Same API in, same API out. */
  wrap<TDb>(db: TDb): TDb;
  /** Wrap your server handler: opens the request scope, stamps headers. */
  middleware(handler: Handler): Handler;
  /** Manually add tags to the current request (raw SQL, computed pages). */
  tag(...tags: string[]): void;
  /** Purge immediately: drains the pending batch plus `tags` in one send.
   * Resolves once the purger accepted it and REJECTS on failure — deploy
   * scripts get a real exit code. With no arguments and nothing pending, it
   * reports the most recent send, so a just-failed batch never reads as
   * success. Also observable as purge-batch / purge-error events. */
  purge(...tags: string[]): Promise<void>;
  /** Purge every page this cache tagged (one send of `allTag`) — immediate,
   * rejects on failure. The deploy/release hook; run it after migrations. */
  purgeAll(): Promise<void>;
  /** Join the pending purge batch: deduplicated, settled (`settleMs`), and
   * flushed alongside write-derived purges (the purge-batch event).
   * Fire-and-forget — failures surface as purge-error events, not throws.
   * For CMS hooks and admin tooling inside the request path. */
  purgeBatch(...tags: string[]): void;
  /** Drain the pending batch, swallowing failures (logged / purge-error
   * event) — for shutdown and tests. `purge()` is the throwing sibling. */
  flush(): Promise<void>;
}
