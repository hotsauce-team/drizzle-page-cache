import { assertEquals } from "@std/assert";
import { eq, sql } from "drizzle-orm";
import { createPageCache } from "../page_cache.ts";
import { litespeedPurger } from "../purgers.ts";
import {
  createTestContext,
  posts,
  RecordingPurger,
  schema,
} from "./helpers.ts";

function litespeedCache(purge = new RecordingPurger()) {
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purge,
    settleMs: 1,
    header: "X-LiteSpeed-Tag",
    headerSeparator: ",",
    cacheHeaders: { "X-LiteSpeed-Cache-Control": "public, max-age=300" },
    wildcardTag: "dpc-wild",
    purgeEcho: { token: "secret" },
  });
  return { db: pageCache.wrap(base.raw), pageCache, purge };
}

Deno.test("litespeed headers: tag header, comma separator, cache-control", async () => {
  const { db, pageCache } = litespeedCache();
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).limit(2);
    pageCache.tag("custom");
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("X-LiteSpeed-Tag"), "posts,custom");
  assertEquals(
    res.headers.get("X-LiteSpeed-Cache-Control"),
    "public, max-age=300",
  );
  assertEquals(res.headers.get("Surrogate-Key"), null);
});

Deno.test("wildcardTag renames * on responses AND purges (never a bare *)", async () => {
  const { db, pageCache, purge } = litespeedCache();
  const handler = pageCache.middleware(async () => {
    await db.select({ n: sql<number>`1` }).from(sql`(select 1)`); // opaque read
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("X-LiteSpeed-Tag"), "dpc-wild");

  pageCache.purgeTags("*");
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purge.all, ["dpc-wild"]);
});

Deno.test("purge-echo route: 403 without token, purge header with it, never cacheable", async () => {
  const { pageCache } = litespeedCache();
  const handler = pageCache.middleware(() => new Response("app"));

  const forbidden = await handler(
    new Request("http://localhost/__drizzle-page-cache/purge?tags=posts"),
  );
  assertEquals(forbidden.status, 403);

  const ok = await handler(
    new Request(
      "http://localhost/__drizzle-page-cache/purge?token=secret&tags=posts:7,posts",
    ),
  );
  assertEquals(ok.status, 200);
  assertEquals(ok.headers.get("X-LiteSpeed-Purge"), "tag=posts:7, tag=posts");
  assertEquals(ok.headers.get("X-LiteSpeed-Cache-Control"), "no-cache");
  assertEquals(ok.headers.get("Cache-Control"), "no-store");
});

Deno.test("litespeedPurger fetches the echo route through the proxy URL", async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string) => {
    seen.push(String(input));
    return Promise.resolve(new Response("purged"));
  }) as typeof fetch;
  try {
    const purger = litespeedPurger(
      "http://ols/__drizzle-page-cache/purge",
      "secret",
    );
    await purger.purge(["posts:7", "posts"]);
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(seen.length, 1);
  const url = new URL(seen[0]);
  assertEquals(url.searchParams.get("token"), "secret");
  assertEquals(url.searchParams.get("tags"), "posts:7,posts");
});

Deno.test("end-to-end within middleware: write schedules litespeed-shaped purge", async () => {
  const { db, pageCache, purge } = litespeedCache();
  await db.update(posts).set({ title: "x" }).where(eq(posts.id, 3));
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  // The bucket flush arrives renamed — never a bare `*` toward LiteSpeed.
  assertEquals(purge.all, ["dpc-wild", "posts", "posts:3"]);
});
