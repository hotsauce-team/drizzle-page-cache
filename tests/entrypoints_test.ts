// The directory entrypoints (adapter-style factories): each wires its
// purger from `site` and rejects `purge` at compile time. The canonical
// dialect modules are `surrogate-key` (imported below via its `nginx` and
// `angie` product re-exports) and `xkey` (via `varnish`); `souin` is its
// own dialect. The litespeed entrypoint has its own richer test
// (litespeed_entry_test.ts).

import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { createPageCache as createSouinPageCache } from "../souin/mod.ts";
import { createPageCache as createVarnishPageCache } from "../varnish/mod.ts";
import { createPageCache as createAngiePageCache } from "../angie/mod.ts";
import { createPageCache as createNginxPageCache } from "../nginx/mod.ts";
import { createTestContext, posts, schema } from "./helpers.ts";
import type { PageCache } from "../types.ts";

function withStubbedFetch() {
  const calls: { url: string; method?: string; headers?: HeadersInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: init?.headers,
    });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** Run one write through a wrapped db and flush the purge queue. */
async function writeAndFlush(pageCache: PageCache) {
  const base = createTestContext();
  const db = pageCache.wrap(base.raw);
  const { calls, restore } = withStubbedFetch();
  try {
    await db.update(posts).set({ title: "x" }).where(eq(posts.id, 3));
    await new Promise((r) => setTimeout(r, 5));
    await pageCache.flush();
  } finally {
    restore();
  }
  return calls;
}

Deno.test("souin entrypoint: site (+ default apiPath) wires the PURGE endpoint", async () => {
  const pageCache = createSouinPageCache({
    schema,
    site: "http://localhost/", // trailing slash normalized
    settleMs: 1,
  });
  const calls = await writeAndFlush(pageCache);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "http://localhost/souin-api/souin");
  assertEquals(calls[0].method, "PURGE");
  const keys = new Headers(calls[0].headers).get("Surrogate-Key") ?? "";
  assertEquals(keys.split(", ").sort(), ["dpc-unknown", "posts", "posts:3"]);
});

Deno.test("varnish entrypoint: one PURGE to site with the xkey header", async () => {
  const pageCache = createVarnishPageCache({
    schema,
    site: "http://localhost",
    settleMs: 1,
  });
  const calls = await writeAndFlush(pageCache);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "http://localhost");
  assertEquals(calls[0].method, "PURGE");
  const keys = new Headers(calls[0].headers).get("xkey") ?? "";
  assertEquals(keys.split(" ").sort(), ["dpc-unknown", "posts", "posts:3"]);
});

Deno.test("nginx entrypoint: one POST to the purge endpoint with tags in Surrogate-Key", async () => {
  const pageCache = createNginxPageCache({
    schema,
    site: "http://localhost/", // trailing slash normalized
    settleMs: 1,
  });
  const calls = await writeAndFlush(pageCache);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "http://localhost/__dpc/purge");
  assertEquals(calls[0].method, "POST");
  const headers = new Headers(calls[0].headers);
  assertEquals(
    (headers.get("Surrogate-Key") ?? "").split(" ").sort(),
    ["dpc-unknown", "posts", "posts:3"],
  );
  // No token option -> no token header.
  assertEquals(headers.get("X-Purge-Token"), null);
});

Deno.test("angie entrypoint: alias of nginx; purgePath/purgeToken wire through", async () => {
  const pageCache = createAngiePageCache({
    schema,
    site: "http://localhost",
    purgePath: "/_cache/purge",
    purgeToken: "s3cr3t",
    settleMs: 1,
  });
  const calls = await writeAndFlush(pageCache);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "http://localhost/_cache/purge");
  assertEquals(calls[0].method, "POST");
  const headers = new Headers(calls[0].headers);
  assertEquals(
    (headers.get("Surrogate-Key") ?? "").split(" ").sort(),
    ["dpc-unknown", "posts", "posts:3"],
  );
  assertEquals(headers.get("X-Purge-Token"), "s3cr3t");
});

Deno.test("entrypoints: `purge` is controlled and rejected at compile time", () => {
  const noopPurger = { purge: () => Promise.resolve() };
  const _souin: Parameters<typeof createSouinPageCache>[0] = {
    schema,
    site: "http://localhost",
    // @ts-expect-error — `purger` is wired by the souin entrypoint
    purger: noopPurger,
  };
  const _varnish: Parameters<typeof createVarnishPageCache>[0] = {
    schema,
    site: "http://localhost",
    // @ts-expect-error — `purger` is wired by the varnish entrypoint
    purger: noopPurger,
  };
  const _angie: Parameters<typeof createAngiePageCache>[0] = {
    schema,
    site: "http://localhost",
    // @ts-expect-error — `purger` is wired by the angie entrypoint
    purger: noopPurger,
  };
  const _nginx: Parameters<typeof createNginxPageCache>[0] = {
    schema,
    site: "http://localhost",
    // @ts-expect-error — `purger` is wired by the nginx entrypoint
    purger: noopPurger,
  };
  assertEquals(typeof createSouinPageCache, "function");
});
