import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
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
    purger,
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
  assertEquals([...(batch!.tags as string[])].sort(), [
    "dpc-unknown",
    "posts",
    "posts:2",
  ]);
});

Deno.test("purge-error event fires when the purger throws", async () => {
  const events: PageCacheEvent[] = [];
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purger: {
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
  assertEquals([...(err as { tags: readonly string[] }).tags].sort(), [
    "dpc-unknown",
    "posts",
  ]);
});

Deno.test("unobserved-read event fires once per reason (deduplicated)", async () => {
  const { db, pageCache, events } = withEvents();
  const handler = pageCache.middleware(async () => {
    // subquery-ish non-table from(): raw SQL fragment is opaque to the facade
    await db.select({ n: sql<number>`1` }).from(sql`(select 1)`);
    await db.select({ n: sql<number>`1` }).from(sql`(select 2)`);
    return new Response("ok");
  });
  await handler(new Request("http://localhost/p"));
  const unobservedReads = events.filter((e) => e.kind === "unobserved-read");
  assertEquals(unobservedReads.length, 1);
});

Deno.test("opaque-read response carries the unknown-bucket tag", async () => {
  const { db, pageCache } = withEvents();
  const handler = pageCache.middleware(async () => {
    await db.select({ n: sql<number>`1` }).from(sql`(select 1)`);
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("Surrogate-Key"), "dpc-unknown dpc-all");
});

Deno.test("header-overflow collapses row tags to table tags and emits", async () => {
  const events: PageCacheEvent[] = [];
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purger: new RecordingPurger(),
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
    "dpc-all",
    "posts",
    "users",
  ]);
  assertEquals(events.filter((e) => e.kind === "header-overflow").length, 1);
});

Deno.test("header budget is measured in UTF-8 bytes, not UTF-16 code units", async () => {
  const events: PageCacheEvent[] = [];
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purger: new RecordingPurger(),
    tagPrefix: "é_", // 2 code units, 3 UTF-8 bytes
    maxHeaderBytes: 25,
    onEvent: (e) => events.push(e),
  });
  const _db = pageCache.wrap(base.raw);
  const handler = pageCache.middleware(() => {
    pageCache.tag("posts:123456");
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  // "é_posts:123456 é_dpc-all" = 24 code units but 26 UTF-8 bytes → over
  // the 25-byte budget, so row tags must collapse.
  assertEquals(res.headers.get("Surrogate-Key"), "é_posts é_dpc-all");
  assertEquals(events.filter((e) => e.kind === "header-overflow").length, 1);
});

Deno.test("still over budget after collapse → degrade to the reserved tags", async () => {
  const events: PageCacheEvent[] = [];
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purger: new RecordingPurger(),
    maxHeaderBytes: 25,
    onEvent: (e) => events.push(e),
  });
  const _db = pageCache.wrap(base.raw);
  const handler = pageCache.middleware(() => {
    for (let i = 10; i < 30; i++) pageCache.tag(`t${i}`); // 20 table-level tags
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  // Table tags alone blow the budget; the safe floor is the bucket (purged
  // on every write) plus the all-pages tag.
  assertEquals(res.headers.get("Surrogate-Key"), "dpc-unknown dpc-all");
  assertEquals(events.filter((e) => e.kind === "header-overflow").length, 1);
});

Deno.test("debug: X-Cache-Tags mirrors the wire tags on cacheable responses", async () => {
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purger: new RecordingPurger(),
    debug: true,
  });
  const db = pageCache.wrap(base.raw);
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).where(eq(posts.id, 3));
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("Surrogate-Key"), "posts:3 dpc-all");
  assertEquals(res.headers.get("X-Cache-Tags"), "posts:3 dpc-all");
});

Deno.test("debug: true exposes X-Cache-Tags even on safety-gated responses", async () => {
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purger: new RecordingPurger(),
    debug: true,
  });
  const db = pageCache.wrap(base.raw);
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).where(eq(posts.id, 4));
    return new Response("account page", {
      headers: { "Set-Cookie": "sid=abc" },
    });
  });
  const res = await handler(new Request("http://localhost/account/posts/4"));
  assertEquals(res.headers.get("X-Cache-Tags"), "posts:4");
  assertEquals(res.headers.get("Surrogate-Key"), null); // still not cacheable
});

Deno.test("header-overflow: uncacheable when even the reserved tags cannot fit", async () => {
  const events: PageCacheEvent[] = [];
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purger: new RecordingPurger(),
    maxHeaderBytes: 5, // smaller than "dpc-unknown dpc-all"
    onEvent: (e) => events.push(e),
  });
  const _db = pageCache.wrap(base.raw);
  const handler = pageCache.middleware(() => {
    pageCache.tag("posts:1");
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  // A page cached without its tags could never be purged — serve uncached.
  assertEquals(res.headers.get("Surrogate-Key"), null);
  assertEquals(res.headers.get("Cache-Control"), null);
  assertEquals(events.filter((e) => e.kind === "header-overflow").length, 1);
});

// -- tagPrefix -----------------------------------------------------------------

Deno.test("tagPrefix namespaces derived tags, manual tags, and purges", async () => {
  const base = createTestContext();
  const purger = new RecordingPurger();
  const pageCache = createPageCache({
    schema,
    purger,
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
    "shop_dpc-all",
    "shop_posts:7",
  ]);

  await db.update(posts).set({ title: "x" }).where(eq(posts.id, 7));
  pageCache.purgeBatch("custom");
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, [
    "shop_custom",
    "shop_dpc-unknown",
    "shop_posts",
    "shop_posts:7",
  ]);
});

Deno.test("unknownTag colliding with a table name throws at init", () => {
  assertThrows(
    () =>
      createPageCache({
        schema,
        purger: new RecordingPurger(),
        unknownTag: "posts",
      }),
    Error,
    "collides",
  );
});

Deno.test("tagPrefix applies to the unknown bucket too", async () => {
  const base = createTestContext();
  const pageCache = createPageCache({
    schema,
    purger: new RecordingPurger(),
    tagPrefix: "shop_",
  });
  const db = pageCache.wrap(base.raw);
  const handler = pageCache.middleware(async () => {
    await db.select({ n: sql<number>`1` }).from(sql`(select 1)`);
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(
    res.headers.get("Surrogate-Key"),
    "shop_dpc-unknown shop_dpc-all",
  );
});

Deno.test("default (no onEvent): purge errors are logged, not thrown", async () => {
  const base = createTestContext();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const pageCache = createPageCache({
      schema,
      purger: {
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
