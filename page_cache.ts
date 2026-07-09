import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_PURGE_ECHO_PATH } from "./purgers.ts";
import { analyzeSchema, WILDCARD } from "./derive.ts";
import { type FacadeContext, wrapDb } from "./facade.ts";
import type {
  Handler,
  PageCache,
  PageCacheEvent,
  PageCacheOptions,
} from "./types.ts";

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
  const wildcardTag = options.wildcardTag ?? WILDCARD;
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
  const withPrefix = (tag: string): string =>
    prefix + (tag === WILDCARD ? wildcardTag : tag);

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
        // Purge-echo route: the purge header must flow THROUGH the proxy
        // (LiteSpeed-style header-driven purging). Never cached.
        if (echo !== undefined) {
          const url = new URL(req.url);
          if (url.pathname === echo.path) {
            if (req.method !== "GET" && req.method !== "POST") {
              return new Response("method not allowed", {
                status: 405,
                headers: { "Allow": "GET, POST" },
              });
            }
            if (!timingSafeEqual(url.searchParams.get("token") ?? "", echo.token)) {
              return new Response("forbidden", { status: 403 });
            }
            const tags = (url.searchParams.get("tags") ?? "")
              .split(",").map((t) => t.trim()).filter((t) => t !== "");
            const headers = new Headers({
              "Cache-Control": "no-store",
              "X-LiteSpeed-Cache-Control": "no-cache",
            });
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
        if (options.debug) {
          out.headers.set("X-Cache-Tags", [...tags].join(separator));
        }
        if (cacheable) {
          const enc = new TextEncoder();
          let value = [...tags].join(separator);
          if (enc.encode(value).length > maxHeaderBytes) {
            emit({
              kind: "header-overflow",
              count: tags.size,
              path: new URL(req.url).pathname,
            });
            value = collapse(tags).join(separator);
            // Even the collapsed table-tag set overflows — dropping any tag
            // would be the dangerous direction (a write to that table would
            // miss this page), so fall back to the wildcard bucket, which
            // every purge reaches. Safe over-purge.
            if (enc.encode(value).length > maxHeaderBytes) {
              value = withPrefix(WILDCARD);
            }
          }
          out.headers.set(header, value);
          out.headers.set(
            "Cache-Control",
            `max-age=0, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
          );
          for (const [k, v] of Object.entries(options.cacheHeaders ?? {})) {
            out.headers.set(k, v);
          }
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
