import { AsyncLocalStorage } from "node:async_hooks";
import { analyzeSchema } from "./derive.ts";
import { type FacadeContext, wrapDb } from "./facade.ts";
import type { Handler, PageCache, PageCacheOptions } from "./types.ts";

export function createPageCache(options: PageCacheOptions): PageCache {
  const header = options.header ?? "Surrogate-Key";
  const ttl = options.ttl ?? 3600;
  const swr = options.staleWhileRevalidate ?? 30;
  const settleMs = options.settleMs ?? 50;
  const exclude = options.exclude ?? ["/admin"];
  const onPurgeError = options.onPurgeError ??
    ((error: unknown, tags: readonly string[]) =>
      console.error("drizzle-page-cache: purge failed", { tags, error }));
  const shouldTag = options.shouldTag ??
    ((req: Request, res: Response) => {
      if (req.method !== "GET" || !res.ok) return false;
      const path = new URL(req.url).pathname;
      return !exclude.some((prefix) =>
        path === prefix ||
        path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
      );
    });

  const info = analyzeSchema(options.schema);
  const scope = new AsyncLocalStorage<Set<string>>();

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
      .then(() => options.purge.purge(batch))
      .catch((error) => onPurgeError(error, batch));
    return inFlight;
  }

  function schedulePurge(tags: Iterable<string>): void {
    let added = false;
    for (const t of tags) {
      pending.add(t);
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
      if (store) { for (const t of tags) store.add(t); }
    },
    schedulePurge,
  };

  return {
    wrap: (db) => wrapDb(db, ctx),

    middleware(handler: Handler): Handler {
      return async (req) => {
        const tags = new Set<string>();
        const res = await scope.run(tags, async () => await handler(req));
        if (tags.size === 0 || !shouldTag(req, res)) return res;
        const out = new Response(res.body, res);
        out.headers.set(header, [...tags].join(" "));
        out.headers.set(
          "Cache-Control",
          `max-age=0, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
        );
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
