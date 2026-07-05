import type { Purger } from "./types.ts";

/**
 * Caddy cache-handler (Souin): PURGE by Surrogate-Key against the Souin API.
 * Requires `cache { api { souin } }` in the Caddyfile; default endpoint is
 * `http://host/souin-api/souin`.
 */
export function souinPurger(apiUrl: string): Purger {
  return {
    async purge(tags) {
      const res = await fetch(apiUrl, {
        method: "PURGE",
        headers: { "Surrogate-Key": tags.join(", ") },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`souin purge: ${res.status}`);
      }
    },
  };
}

/** Varnish with the xkey vmod: one PURGE carrying the keys. */
export function varnishPurger(url: string): Purger {
  return {
    async purge(tags) {
      const res = await fetch(url, {
        method: "PURGE",
        headers: { xkey: tags.join(" ") },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`varnish purge: ${res.status}`);
      }
    },
  };
}

/**
 * Angie / nginx-family (no tag support): map tags to URL patterns and issue
 * wildcard PURGE requests (Angie's cache-purge module supports `/path/*`).
 * The '*' entry is the fallback for unknown tags — omit it to skip them.
 */
export function angiePurger(
  base: string,
  routes: Record<string, string[]>,
): Purger {
  return {
    async purge(tags) {
      const urls = new Set<string>(
        tags.flatMap((tag) => {
          const table = tag.includes(":")
            ? tag.slice(0, tag.indexOf(":"))
            : tag;
          return routes[tag] ?? routes[table] ?? routes["*"] ?? [];
        }),
      );
      await Promise.all(
        [...urls].map(async (path) => {
          const res = await fetch(base + path, { method: "PURGE" });
          if (!res.ok && res.status !== 404) {
            throw new Error(`angie purge ${path}: ${res.status}`);
          }
        }),
      );
    },
  };
}

/**
 * LiteSpeed / OpenLiteSpeed: purging is header-driven — the backend response
 * must carry `X-LiteSpeed-Purge` while flowing THROUGH the proxy. This purger
 * fetches the middleware's purge-echo route (see `purgeEcho` option) via the
 * proxy's public URL; the echoed header performs the purge.
 *
 * `echoUrl` MUST point at the proxy (e.g. `http://ols/__drizzle-page-cache/purge`),
 * never directly at the app — a purge header the proxy never sees purges nothing.
 */
export function litespeedPurger(echoUrl: string, token: string): Purger {
  return {
    async purge(tags) {
      const url = new URL(echoUrl);
      url.searchParams.set("token", token);
      url.searchParams.set("tags", tags.join(","));
      const res = await fetch(url);
      if (!res.ok) throw new Error(`litespeed purge echo: ${res.status}`);
    },
  };
}

/** POSTs `{ tags: [...] }` as JSON — for custom CDNs and queues. */
export function webhookPurger(url: string, init?: RequestInit): Purger {
  return {
    async purge(tags) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tags }),
        ...init,
      });
      if (!res.ok) throw new Error(`webhook purge: ${res.status}`);
    },
  };
}
