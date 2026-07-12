import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { eq, sql } from "drizzle-orm";
import { createPageCache } from "../src/dialects/litespeed.ts";
import { createTestContext, posts, schema } from "./helpers.ts";

function withStubbedFetch() {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string) => {
    calls.push(String(input));
    return Promise.resolve(new Response("purged"));
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

Deno.test("litespeed entrypoint: one ttl drives s-maxage AND X-LiteSpeed-Cache-Control", async () => {
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    site: "https://example.com",
    token: "secret",
    ttl: 120,
  });
  const db = pageCache.wrap(base.raw);
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).where(eq(posts.id, 3));
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("X-LiteSpeed-Tag"), "posts:3,dpc-all");
  assertEquals(
    res.headers.get("X-LiteSpeed-Cache-Control"),
    "public, max-age=120",
  );
  assertStringIncludes(res.headers.get("Cache-Control") ?? "", "s-maxage=120");
});

Deno.test("litespeed entrypoint: site+token wire the purger and the echo route together", async () => {
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    site: "https://example.com/", // trailing slash normalized
    token: "secret",
    settleMs: 1,
  });
  const db = pageCache.wrap(base.raw);

  // Echo route served by the middleware, guarded by the same token.
  const handler = pageCache.middleware(() => new Response("app"));
  const echo = await handler(
    new Request(
      "http://localhost/__drizzle-page-cache/purge?token=secret&tags=posts:3",
    ),
  );
  assertEquals(echo.status, 200);
  assertEquals(echo.headers.get("X-LiteSpeed-Purge"), "tag=posts:3");

  // Purger fetches the site-derived echo URL with the same token.
  const { calls, restore } = withStubbedFetch();
  try {
    await db.update(posts).set({ title: "x" }).where(eq(posts.id, 3));
    await new Promise((r) => setTimeout(r, 5));
    await pageCache.flush();
  } finally {
    restore();
  }
  assertEquals(calls.length, 1);
  const url = new URL(calls[0]);
  assertEquals(url.origin, "https://example.com");
  assertEquals(url.pathname, "/__drizzle-page-cache/purge");
  assertEquals(url.searchParams.get("token"), "secret");
});

Deno.test("litespeed entrypoint: unknown bucket defaults to dpc-unknown and '*' is rejected", async () => {
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    site: "https://example.com",
    token: "secret",
  });
  const db = pageCache.wrap(base.raw);
  const handler = pageCache.middleware(async () => {
    await db.select({ n: sql<number>`1` }).from(sql`(select 1)`); // opaque
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("X-LiteSpeed-Tag"), "dpc-unknown,dpc-all");

  assertThrows(
    () =>
      createPageCache({
        schema,
        site: "https://example.com",
        token: "secret",
        unknownTag: "*",
      }),
    Error,
    "must not be '*'",
  );
});

Deno.test("litespeed entrypoint: dialect-controlled keys are rejected at compile time", () => {
  const _bad1: Parameters<typeof createPageCache>[0] = {
    schema,
    site: "https://example.com",
    token: "secret",
    // @ts-expect-error — `header` is controlled by the litespeed dialect
    header: "X-Custom",
  };
  const _bad2: Parameters<typeof createPageCache>[0] = {
    schema,
    site: "https://example.com",
    token: "secret",
    // @ts-expect-error — `purger` is controlled by the litespeed dialect
    purger: { purge: () => Promise.resolve() },
  };
  assertEquals(typeof createPageCache, "function");
});
