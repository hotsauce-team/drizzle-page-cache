import { assertEquals, assertStringIncludes } from "@std/assert";
import { eq, sql } from "drizzle-orm";
import { createPageCache } from "../page_cache.ts";
import type { PageCacheEvent } from "../types.ts";
import {
  createTestContext,
  posts,
  RecordingPurger,
  schema,
  users,
} from "./helpers.ts";

function withEvents(options: { settleMs?: number } = {}) {
  const events: PageCacheEvent[] = [];
  const base = createTestContext(options);
  const purger = new RecordingPurger();
  const pageCache = createPageCache({
    schema,
    purge: purger,
    settleMs: options.settleMs ?? 1,
    onEvent: (e) => events.push(e),
  });
  return { db: pageCache.wrap(base.raw), pageCache, purger, events };
}

Deno.test("purge-batch event fires with the flushed tags", async () => {
  const { db, pageCache, events } = withEvents();
  await db.update(posts).set({ title: "x" }).where(eq(posts.id, 2));
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  const batch = events.find((e) => e.kind === "purge-batch");
  assertEquals(batch?.kind, "purge-batch");
  assertEquals([...(batch!.tags as string[])].sort(), ["posts", "posts:2"]);
});

Deno.test("purge-error event fires when the purger throws", async () => {
  const events: PageCacheEvent[] = [];
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purge: {
      // deno-lint-ignore require-await
      purge: async () => {
        throw new Error("endpoint down");
      },
    },
    settleMs: 1,
    onEvent: (e) => events.push(e),
  });
  const db = pageCache.wrap(base.raw);
  await db.insert(posts).values({ title: "t", body: "b", authorId: 1 });
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  const err = events.find((e) => e.kind === "purge-error");
  assertEquals(err?.kind, "purge-error");
  assertEquals((err as { tags: readonly string[] }).tags, ["posts"]);
});

Deno.test("wildcard-tag event fires once per reason (deduplicated)", async () => {
  const { db, pageCache, events } = withEvents();
  const handler = pageCache.middleware(async () => {
    // subquery-ish non-table from(): raw SQL fragment is opaque to the facade
    await db.select({ n: sql<number>`1` }).from(sql`(select 1)`);
    await db.select({ n: sql<number>`1` }).from(sql`(select 2)`);
    return new Response("ok");
  });
  await handler(new Request("http://localhost/p"));
  const wildcards = events.filter((e) => e.kind === "wildcard-tag");
  assertEquals(wildcards.length, 1);
});

Deno.test("wildcard-tagged response carries the * tag", async () => {
  const { db, pageCache } = withEvents();
  const handler = pageCache.middleware(async () => {
    await db.select({ n: sql<number>`1` }).from(sql`(select 1)`);
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("Surrogate-Key"), "*");
});

Deno.test("header-overflow collapses row tags to table tags and emits", async () => {
  const events: PageCacheEvent[] = [];
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purge: new RecordingPurger(),
    maxHeaderBytes: 20,
    onEvent: (e) => events.push(e),
  });
  const db = pageCache.wrap(base.raw);
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).where(eq(posts.id, 1));
    await db.select().from(posts).where(eq(posts.id, 2));
    await db.select().from(posts).where(eq(posts.id, 3));
    await db.select().from(users).where(eq(users.id, 1));
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("Surrogate-Key")?.split(" ").sort(), [
    "posts",
    "users",
  ]);
  assertEquals(events.filter((e) => e.kind === "header-overflow").length, 1);
});

Deno.test("maxHeaderBytes measures bytes, not UTF-16 code units", async () => {
  const events: PageCacheEvent[] = [];
  const pageCache = createPageCache({
    schema,
    purge: new RecordingPurger(),
    maxHeaderBytes: 12,
    onEvent: (e) => events.push(e),
  });
  const handler = pageCache.middleware(() => {
    // "posts:日本語" is 9 code units but 15 UTF-8 bytes. A char-count check
    // (9 <= 12) would let it through; a byte-count check (15 > 12) overflows.
    pageCache.tag("posts:日本語");
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("Surrogate-Key"), "posts");
  assertEquals(events.filter((e) => e.kind === "header-overflow").length, 1);
});

Deno.test("header-overflow falls back to wildcard when table tags still overflow", async () => {
  const pageCache = createPageCache({
    schema,
    purge: new RecordingPurger(),
    maxHeaderBytes: 3,
  });
  const handler = pageCache.middleware(() => {
    pageCache.tag("posts:7"); // collapses to "posts" (5 bytes), still > 3
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("Surrogate-Key"), "*");
});

Deno.test("debug: true exposes X-Cache-Tags even on excluded paths", async () => {
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purge: new RecordingPurger(),
    debug: true,
  });
  const db = pageCache.wrap(base.raw);
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).where(eq(posts.id, 4));
    return new Response("admin page");
  });
  const res = await handler(new Request("http://localhost/admin/posts/4"));
  assertEquals(res.headers.get("X-Cache-Tags"), "posts:4");
  assertEquals(res.headers.get("Surrogate-Key"), null); // still not cacheable
});

// -- tagPrefix -----------------------------------------------------------------

Deno.test("tagPrefix namespaces derived tags, manual tags, and purges", async () => {
  const base = createTestContext();
  const purger = new RecordingPurger();
  const pageCache = createPageCache({
    schema,
    purge: purger,
    settleMs: 1,
    tagPrefix: "shop_",
  });
  const db = pageCache.wrap(base.raw);

  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).where(eq(posts.id, 7));
    pageCache.tag("custom");
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("Surrogate-Key")?.split(" ").sort(), [
    "shop_custom",
    "shop_posts:7",
  ]);

  await db.update(posts).set({ title: "x" }).where(eq(posts.id, 7));
  pageCache.purgeTags("custom");
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, ["shop_custom", "shop_posts", "shop_posts:7"]);
});

Deno.test("tagPrefix applies to the wildcard bucket too", async () => {
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purge: new RecordingPurger(),
    tagPrefix: "shop_",
  });
  const db = pageCache.wrap(base.raw);
  const handler = pageCache.middleware(async () => {
    await db.select({ n: sql<number>`1` }).from(sql`(select 1)`);
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("Surrogate-Key"), "shop_*");
});

Deno.test("default (no onEvent): purge errors are logged, not thrown", async () => {
  const base = createTestContext();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const pageCache = createPageCache({
      schema,
      purge: {
        // deno-lint-ignore require-await
        purge: async () => {
          throw new Error("down");
        },
      },
      settleMs: 1,
    });
    const db = pageCache.wrap(base.raw);
    await db.insert(posts).values({ title: "t", body: "b", authorId: 1 });
    await new Promise((r) => setTimeout(r, 5));
    await pageCache.flush();
  } finally {
    console.error = original;
  }
  assertEquals(errors.length, 1);
  assertStringIncludes(String(errors[0]), "purge failed");
});
