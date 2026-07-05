import { AsyncLocalStorage } from "node:async_hooks";
import { analyzeSchema } from "./derive.ts";
import { type FacadeContext, wrapDb } from "./facade.ts";
import type {
  Handler,
  PageCache,
  PageCacheEvent,
  PageCacheOptions,
} from "./types.ts";

export function createPageCache(options: PageCacheOptions): PageCache {
  const header = options.header ?? "Surrogate-Key";
  const ttl = options.ttl ?? 3600;
  const swr = options.staleWhileRevalidate ?? 30;
  const settleMs = options.settleMs ?? 50;
  const exclude = options.exclude ?? ["/admin"];
  const prefix = options.tagPrefix ?? "";
  const maxHeaderBytes = options.maxHeaderBytes ?? 7900;
  const shouldTag = options.shouldTag ??
    ((req: Request, res: Response) => {
      if (req.method !== "GET" || !res.ok) return false;
      const path = new URL(req.url).pathname;
      return !exclude.some((p) =>
        path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`)
      );
    });

  // -- events: silent by default except the two that can mean stale pages ----
  const seenWildcardReasons = new Set<string>();
  const emit = (event: PageCacheEvent): void => {
    if (event.kind === "wildcard-tag") {
      if (seenWildcardReasons.has(event.reason)) return;
      seenWildcardReasons.add(event.reason);
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
  const scope = new AsyncLocalStorage<Set<string>>();
  const withPrefix = (tag: string): string => prefix + tag;

  // -- purge queue: dedupe + settle; flush() for tests/shutdown ---------------
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  function flushNow(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.size === 0) return inFlight;
    const batch = [...pending];
    pending = new Set();
    inFlight = inFlight
      .then(() => {
        emit({ kind: "purge-batch", tags: batch });
        return options.purge.purge(batch);
      })
      .catch((error) => emit({ kind: "purge-error", tags: batch, error }));
    return inFlight;
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
        flushNow();
      }, settleMs);
      // Don't hold the event loop open for a pending purge (server shutdown).
      (timer as { unref?: () => void }).unref?.();
    }
  }

  const ctx: FacadeContext = {
    info,
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
        const tags = new Set<string>();
        const res = await scope.run(tags, async () => await handler(req));
        if (tags.size === 0) return res;

        const cacheable = shouldTag(req, res);
        if (!cacheable && !options.debug) return res;

        const out = new Response(res.body, res);
        if (options.debug) {
          out.headers.set("X-Cache-Tags", [...tags].join(" "));
        }
        if (cacheable) {
          let value = [...tags].join(" ");
          if (value.length > maxHeaderBytes) {
            const collapsed = collapse(tags);
            emit({
              kind: "header-overflow",
              count: tags.size,
              path: new URL(req.url).pathname,
            });
            value = collapsed.join(" ");
          }
          out.headers.set(header, value);
          out.headers.set(
            "Cache-Control",
            `max-age=0, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
          );
        }
        return out;
      };
    },

    tag(...tags) {
      ctx.addTags(tags);
    },

    purgeTags(...tags) {
      schedulePurge(tags);
    },

    flush: flushNow,
  };
}
