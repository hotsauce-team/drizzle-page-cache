import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_PURGE_ECHO_PATH } from "./purgers.ts";
import { analyzeSchema } from "./derive.ts";
import { type FacadeContext, wrapDb } from "./facade.ts";
import type {
  Handler,
  PageCache,
  PageCacheEvent,
  PageCacheOptions,
} from "./types.ts";

/** Default wire name of the unknown-bucket tag. */
export const DEFAULT_UNKNOWN_TAG = "dpc-unknown";

/** Default wire name of the all-pages tag (`purgeAll()` purges it). */
export const DEFAULT_ALL_TAG = "dpc-all";

/** Length-independent string comparison — avoids a timing oracle on the
 * shared purge token. Zero-dep (no node:crypto), Web-standard only. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Fold the length difference into the accumulator so mismatched lengths
  // still take the same code path.
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function createPageCache(options: PageCacheOptions): PageCache {
  const header = options.header ?? "Surrogate-Key";
  const separator = options.headerSeparator ?? " ";
  const ttl = options.ttl ?? 3600;
  const swr = options.staleWhileRevalidate ?? 30;
  const settleMs = options.settleMs ?? 50;
  const prefix = options.tagPrefix ?? "";
  const unknownTag = options.unknownTag ?? DEFAULT_UNKNOWN_TAG;
  const allTag = options.allTag ?? DEFAULT_ALL_TAG;
  const maxHeaderBytes = options.maxHeaderBytes ?? 7900;
  const echo = options.purgeEcho === undefined ? undefined : {
    token: options.purgeEcho.token,
    path: options.purgeEcho.path ?? DEFAULT_PURGE_ECHO_PATH,
    header: options.purgeEcho.header ?? "X-LiteSpeed-Purge",
    value: options.purgeEcho.value ??
      ((tags: readonly string[]) => tags.map((t) => `tag=${t}`).join(", ")),
  };
  // Always enforced, on top of any custom shouldTag: the app's own
  // non-shareable signals win — otherwise the header stamping below would
  // turn a personalized response into a shared-cache entry. Mirrors what the
  // Lua log() phase refuses to store.
  const shareable = (res: Response): boolean => {
    if (res.headers.has("Set-Cookie")) return false;
    const cc = res.headers.get("Cache-Control")?.toLowerCase() ?? "";
    // `=` catches the RFC 7234 qualified forms (private="x", no-cache="x")
    // — this cache can't strip individual fields, so treat as non-shareable.
    return !/(^|[\s,])(private|no-store|no-cache)([\s,;=]|$)/.test(cc);
  };
  const shouldTag = options.shouldTag ??
    ((req: Request, res: Response) => req.method === "GET" && res.ok);

  // -- events: silent by default except the two that can mean stale pages ----
  const seenUnobservedReadReasons = new Set<string>();
  const emit = (event: PageCacheEvent): void => {
    if (event.kind === "unobserved-read") {
      if (seenUnobservedReadReasons.has(event.reason)) return;
      seenUnobservedReadReasons.add(event.reason);
    }
    if (options.onEvent) {
      options.onEvent(event);
      return;
    }
    if (event.kind === "purge-error") {
      console.error("drizzle-page-cache: purge failed", event);
    } else if (event.kind === "unobserved-write") {
      console.warn(
        "drizzle-page-cache: unobserved write — tagged pages may go stale until TTL",
        event,
      );
    }
  };

  const info = analyzeSchema(options.schema);
  // Reserved tags colliding with a table name would be catastrophic: the
  // bucket rides every purge batch (evicting that table's list pages on every
  // write), and a table named like `allTag` would flush the whole site on
  // every write to it.
  const tableNames = new Set(info.tableByKey.values());
  if (tableNames.has(unknownTag)) {
    throw new Error(
      `drizzle-page-cache: unknownTag '${unknownTag}' collides with the table '${unknownTag}' — pick a name that is not a table tag`,
    );
  }
  if (tableNames.has(allTag)) {
    throw new Error(
      `drizzle-page-cache: allTag '${allTag}' collides with the table '${allTag}' — pick a name that is not a table tag`,
    );
  }
  if (allTag === unknownTag) {
    throw new Error(
      `drizzle-page-cache: allTag and unknownTag are both '${allTag}' — they must differ (the bucket rides every purge batch, so every write would flush the site)`,
    );
  }
  const scope = new AsyncLocalStorage<Set<string>>();
  const withPrefix = (tag: string): string => prefix + tag;
  const unknownWire = withPrefix(unknownTag);
  const allWire = withPrefix(allTag);
  const encoder = new TextEncoder();
  const nonAscii = /[^\x00-\x7F]/;
  // `maxHeaderBytes` is a BYTE budget. UTF-16 code units never exceed UTF-8
  // bytes, so an over-length string is over-budget without encoding; an
  // all-ASCII string has bytes === length; only non-ASCII values at or
  // under the budget pay the encode (no allocation on the common path).
  const overBudget = (value: string): boolean => {
    if (value.length > maxHeaderBytes) return true;
    if (!nonAscii.test(value)) return false;
    return encoder.encode(value).length > maxHeaderBytes;
  };

  // -- purge queue: dedupe + settle; flush() for tests/shutdown ---------------
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  // The rethrowing view of the most recent send — what a bare `purge()`
  // reports when there is nothing left to drain. Always also caught via
  // `inFlight`, so dropping it never surfaces an unhandled rejection.
  let lastSend: Promise<void> = Promise.resolve();

  /** Drain the pending batch. `rethrow` selects the error contract: the
   * returned promise rejects on purger failure (`purge()`/`purgeAll()`) or
   * swallows it after the purge-error event (`flush()`, settle timer). The
   * internal chain always stays caught either way. */
  function drain(rethrow: boolean): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.size === 0) return rethrow ? lastSend : inFlight;
    // Unknown-bucket pages are opaque — any write might affect them — so
    // every batch carries the bucket tag (the tag model's "every purge").
    pending.add(unknownWire);
    const batch = [...pending];
    pending = new Set();
    const send = inFlight.then(() => {
      emit({ kind: "purge-batch", tags: batch });
      return options.purger.purge(batch);
    });
    lastSend = send;
    inFlight = send.catch((error) =>
      emit({ kind: "purge-error", tags: batch, error })
    );
    return rethrow ? send : inFlight;
  }

  function schedulePurge(tags: Iterable<string>): void {
    let added = false;
    for (const t of tags) {
      pending.add(withPrefix(t));
      added = true;
    }
    if (added && timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        drain(false);
      }, settleMs);
      // Don't hold the event loop open for a pending purge (server shutdown).
      (timer as { unref?: () => void }).unref?.();
    }
  }

  const ctx: FacadeContext = {
    info,
    unknownTag,
    addTags: (tags) => {
      const store = scope.getStore();
      if (store) {
        for (const t of tags) store.add(withPrefix(t));
      }
    },
    schedulePurge,
    emit: (kind, reason) => emit({ kind, reason }),
  };

  /** Collapse row tags (`t:id`) to their table tags — safe over-tagging. */
  const collapse = (tags: Set<string>): string[] => [
    ...new Set([...tags].map((t) => {
      const i = t.indexOf(":");
      return i === -1 ? t : t.slice(0, i);
    })),
  ];

  return {
    wrap: (db) => wrapDb(db, ctx),

    middleware(handler: Handler): Handler {
      return async (req) => {
        // Purge-echo route: the purge header must flow THROUGH the proxy
        // (LiteSpeed-style header-driven purging). Never cached.
        if (echo !== undefined) {
          const url = new URL(req.url);
          if (url.pathname === echo.path) {
            // Error responses carry no-store too: a proxy that cached one
            // (405 is even heuristically cacheable per RFC 9111) could pin
            // it in front of the echo route and block later purges.
            const noStore = {
              "Cache-Control": "no-store",
              "X-LiteSpeed-Cache-Control": "no-cache",
            };
            if (req.method !== "GET" && req.method !== "POST") {
              return new Response("method not allowed", {
                status: 405,
                headers: { ...noStore, "Allow": "GET, POST" },
              });
            }
            if (
              !timingSafeEqual(url.searchParams.get("token") ?? "", echo.token)
            ) {
              return new Response("forbidden", {
                status: 403,
                headers: noStore,
              });
            }
            const tags = (url.searchParams.get("tags") ?? "")
              .split(",").map((t) => t.trim()).filter((t) => t !== "");
            const headers = new Headers(noStore);
            if (tags.length > 0) headers.set(echo.header, echo.value(tags));
            return new Response("purged", { headers });
          }
        }

        const tags = new Set<string>();
        const res = await scope.run(tags, async () => await handler(req));
        if (tags.size === 0) return res;

        const cacheable = shareable(res) && shouldTag(req, res);
        if (!cacheable && !options.debug) return res;

        const out = new Response(res.body, res);
        if (cacheable) {
          // The all-pages tag rides every tagged response (never any
          // automatic purge) so purgeAll() can flush the whole site.
          const wire = new Set(tags);
          wire.add(allWire);
          let wireTags = [...wire];
          if (overBudget(wireTags.join(separator))) {
            emit({
              kind: "header-overflow",
              count: wire.size,
              path: new URL(req.url).pathname,
            });
            wireTags = collapse(wire);
            if (overBudget(wireTags.join(separator))) {
              // Even the collapsed table-tag set overflows — dropping any
              // tag would be the dangerous direction (a write to that table
              // would miss this page), so fall back to the reserved tags:
              // the bucket is purged by every write. Safe over-purge.
              wireTags = [unknownWire, allWire];
            }
            if (overBudget(wireTags.join(separator))) {
              // Even the reserved tags don't fit (tiny maxHeaderBytes, or a
              // long tagPrefix): a page cached without its tags could never
              // be purged, so serve it uncached instead of emitting the
              // oversized header maxHeaderBytes exists to prevent.
              if (options.debug) {
                out.headers.set("X-Cache-Tags", [...tags].join(separator));
              }
              return out;
            }
          }
          out.headers.set(header, wireTags.join(separator));
          out.headers.set(
            "Cache-Control",
            `max-age=0, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
          );
          for (const [k, v] of Object.entries(options.cacheHeaders ?? {})) {
            out.headers.set(k, v);
          }
          // Debug mirrors what actually went on the wire.
          if (options.debug) {
            out.headers.set("X-Cache-Tags", wireTags.join(separator));
          }
        } else if (options.debug) {
          out.headers.set("X-Cache-Tags", [...tags].join(separator));
        }
        return out;
      };
    },

    tag(...tags) {
      ctx.addTags(tags);
    },

    purge(...tags) {
      for (const t of tags) pending.add(withPrefix(t));
      return drain(true);
    },

    purgeAll() {
      pending.add(allWire);
      return drain(true);
    },

    purgeBatch(...tags) {
      schedulePurge(tags);
    },

    flush: () => drain(false),
  };
}
