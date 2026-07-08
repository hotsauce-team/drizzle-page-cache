import type { Purger } from "./types.ts";

/** Default path of the middleware's purge-echo route (see `purgeEcho`). */
export const DEFAULT_PURGE_ECHO_PATH = "/__drizzle-page-cache/purge";

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

/** Default route of the Lua purge endpoint (`nginx/purge.lua`). The API is
 * Fastly-shaped: `POST <path>` with `Surrogate-Key: tag1 tag2` (batch —
 * what this purger sends), `POST <path>/<tag>` (single), and
 * `POST <path>_all` (flush). */
export const DEFAULT_NGINX_PURGE_PATH = "/__dpc/purge";

/**
 * nginx family (free nginx, Angie, OpenResty) running this package's
 * `nginx/purge.lua`: one POST to the proxy's dedicated purge endpoint
 * carrying the tags in a `Surrogate-Key` header — the same header the
 * middleware stamps on responses, which the Lua log phase records per
 * cache key, so purging is tag-precise with no tag → URL mapping. The
 * endpoint location should be access-restricted; if it sets
 * `$dpc_purge_token`, pass the matching `token` here.
 */
export function nginxPurger(
  base: string,
  options?: { path?: string; token?: string },
): Purger {
  const url = base + (options?.path ?? DEFAULT_NGINX_PURGE_PATH);
  return {
    async purge(tags) {
      const headers: Record<string, string> = {
        "Surrogate-Key": tags.join(" "),
      };
      if (options?.token !== undefined) {
        headers["X-Purge-Token"] = options.token;
      }
      const res = await fetch(url, { method: "POST", headers });
      if (!res.ok) throw new Error(`nginx purge: ${res.status}`);
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
