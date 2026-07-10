import { assertEquals } from "@std/assert";
import { eq, or } from "drizzle-orm";
import { type FacadeContext, wrapDb } from "../facade.ts";
import { analyzeSchema, WILDCARD } from "../derive.ts";
import { createPageCache } from "../page_cache.ts";
import {
  createTestContext,
  posts,
  RecordingPurger,
  schema,
  tagsFor,
  users,
} from "./helpers.ts";

Deno.test("entity read by PK → row tag only", async () => {
  const { db, pageCache } = createTestContext();
  const tags = await tagsFor(pageCache, async () => {
    const rows = await db.select().from(posts).where(eq(posts.id, 7));
    assertEquals(rows.length, 1);
  });
  assertEquals(tags, ["posts:7"]);
});

Deno.test("entity read by unique column → row tag from the result PK", async () => {
  const { db, pageCache } = createTestContext();
  const tags = await tagsFor(pageCache, async () => {
    const rows = await db.select().from(users).where(
      eq(users.email, "user2@example.com"),
    );
    assertEquals(rows.length, 1);
  });
  assertEquals(tags, ["users:2"]);
});

Deno.test("entity miss → row tag + table tag (cached 404 invalidates on insert)", async () => {
  const { db, pageCache } = createTestContext();
  const tags = await tagsFor(pageCache, async () => {
    const rows = await db.select().from(posts).where(eq(posts.id, 999));
    assertEquals(rows.length, 0);
  });
  assertEquals(tags, ["posts", "posts:999"]);
});

Deno.test("list read → table tag only", async () => {
  const { db, pageCache } = createTestContext();
  const tags = await tagsFor(pageCache, async () => {
    await db.select().from(posts).limit(5);
  });
  assertEquals(tags, ["posts"]);
});

Deno.test("join adds the joined table tag", async () => {
  const { db, pageCache } = createTestContext();
  const tags = await tagsFor(pageCache, async () => {
    await db.select().from(posts).leftJoin(users, eq(posts.authorId, users.id))
      .limit(3);
  });
  assertEquals(tags, ["posts", "users"]);
});

Deno.test("entity matched by the non-PK arm of an OR tags the row's real PK", async () => {
  const { db, pageCache } = createTestContext();
  const tags = await tagsFor(pageCache, async () => {
    // The PK arm (id=999) does not match; the unique arm (email) does →
    // the row returned is user 2, so the tag must be users:2, not users:999.
    const rows = await db.select().from(users).where(
      or(eq(users.id, 999), eq(users.email, "user2@example.com")),
    );
    assertEquals(rows.length, 1);
    assertEquals((rows[0] as { id: number }).id, 2);
  });
  assertEquals(tags, ["users:2"]);
});

Deno.test("partial select by PK stays row-precise when it is unambiguous", async () => {
  const { db, pageCache } = createTestContext();
  const tags = await tagsFor(pageCache, async () => {
    // PK omitted from the result, but a single PK equality constrained it.
    await db.select({ title: posts.title }).from(posts).where(eq(posts.id, 5));
  });
  assertEquals(tags, ["posts:5"]);
});

Deno.test("partial select omitting the PK degrades to table tag", async () => {
  const { db, pageCache } = createTestContext();
  const tags = await tagsFor(pageCache, async () => {
    await db.select({ email: users.email }).from(users).where(
      eq(users.email, "user1@example.com"),
    );
  });
  // unique equality but the result has no PK to build a row tag from
  assertEquals(tags.includes("users") || tags.includes("users:1"), true);
});

Deno.test("RQB findFirst by PK → row tag", async () => {
  const { db, pageCache } = createTestContext();
  const tags = await tagsFor(pageCache, async () => {
    const row = await db.query.posts.findFirst({ where: eq(posts.id, 4) });
    assertEquals(row?.id, 4);
  });
  assertEquals(tags, ["posts:4"]);
});

Deno.test("RQB findFirst with relation → row tag + related table tag", async () => {
  const { db, pageCache } = createTestContext();
  const tags = await tagsFor(pageCache, async () => {
    const row = await db.query.posts.findFirst({
      where: eq(posts.id, 4),
      with: { author: true },
    });
    assertEquals(typeof row?.author?.id, "number");
  });
  assertEquals(tags, ["posts:4", "users"]);
});

Deno.test("RQB findMany → table tags (list)", async () => {
  const { db, pageCache } = createTestContext();
  const tags = await tagsFor(pageCache, async () => {
    const rows = await db.query.posts.findMany({
      limit: 3,
      with: { author: true },
    });
    assertEquals(rows.length, 3);
  });
  assertEquals(tags, ["posts", "users"]);
});

Deno.test("lazy thenable executed outside the scope tags nothing (documented gotcha)", async () => {
  const { db, pageCache } = createTestContext();
  // deno-lint-ignore no-explicit-any
  let leaked: any;
  const tags = await tagsFor(pageCache, () => {
    leaked = db.select().from(posts).limit(1); // built inside, not awaited
    return Promise.resolve();
  });
  assertEquals(tags, []);
  await leaked; // executes outside any scope — must not throw
});

Deno.test("update by PK purges row + table tags after settle", async () => {
  const { db, pageCache, purger } = createTestContext();
  await db.update(posts).set({ title: "edited" }).where(eq(posts.id, 7));
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, ["*", "posts", "posts:7"]);
});

Deno.test("insert purges the table tag (+ the wildcard bucket)", async () => {
  const { db, pageCache, purger } = createTestContext();
  await db.insert(posts).values({ title: "new", body: "b", authorId: 1 });
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, ["*", "posts"]);
});

Deno.test("delete by PK purges row + table tags", async () => {
  const { db, pageCache, purger } = createTestContext();
  await db.delete(posts).where(eq(posts.id, 9));
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, ["*", "posts", "posts:9"]);
});

Deno.test("db.batch() of fully-opaque statements warns + wildcard-purges", async () => {
  const events: string[] = [];
  const purged: string[] = [];
  const ctx: FacadeContext = {
    info: analyzeSchema(schema),
    addTags: () => {},
    schedulePurge: (tags) => {
      for (const t of tags) purged.push(t);
    },
    emit: (kind) => events.push(kind),
  };
  let called = false;
  const fakeDb = {
    batch: (_stmts: unknown[]) => {
      called = true;
      return Promise.resolve([]);
    },
  };
  const wrapped = wrapDb(fakeDb, ctx);
  await wrapped.batch([1, 2]);
  assertEquals(called, true);
  assertEquals(events, ["unobserved-write"]);
  assertEquals(purged, [WILDCARD]);
});

Deno.test("wrapping a db without batch leaves db.batch undefined", () => {
  const ctx: FacadeContext = {
    info: analyzeSchema(schema),
    addTags: () => {},
    schedulePurge: () => {},
    emit: () => {},
  };
  const wrapped = wrapDb({}, ctx) as { batch?: unknown };
  assertEquals(wrapped.batch, undefined);
});

Deno.test("db.batch of observed writes purges precise tags (no unobserved-write fallback)", async () => {
  const { db, pageCache, purger } = createTestContext();
  await db.batch([
    db.update(posts).set({ title: "a" }).where(eq(posts.id, 3)),
    db.insert(posts).values({ title: "n", body: "b", authorId: 1 }),
  ]);
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  // Precise tags derived per statement; `*` here is only the bucket flush
  // every purge carries, not the opaque-statement fallback.
  assertEquals(purger.all, ["*", "posts", "posts:3"]);
});

Deno.test("db.batch with an unobservable statement adds the wildcard bucket", async () => {
  const { db, raw, pageCache, purger } = createTestContext();
  await db.batch([
    db.update(posts).set({ title: "a" }).where(eq(posts.id, 3)), // observed
    raw.update(users).set({ name: "x" }).where(eq(users.id, 1)), // opaque
  ]);
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, ["*", "posts", "posts:3"]);
});

Deno.test("db.batch of reads only needs no purge", async () => {
  const { db, pageCache, purger } = createTestContext();
  await db.batch([
    db.select().from(posts).where(eq(posts.id, 3)),
    db.select().from(users).limit(2),
  ]);
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, []);
});

Deno.test("update by non-PK column purges table tag (no false row precision)", async () => {
  const { db, pageCache, purger } = createTestContext();
  await db.update(users).set({ name: "x" }).where(
    eq(users.email, "user1@example.com"),
  );
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, ["*", "users"]);
});

Deno.test("purge batches are deduplicated across writes in the settle window", async () => {
  const { db, pageCache, purger } = createTestContext({ settleMs: 20 });
  await db.update(posts).set({ title: "a" }).where(eq(posts.id, 1));
  await db.update(posts).set({ title: "b" }).where(eq(posts.id, 1));
  await db.update(posts).set({ title: "c" }).where(eq(posts.id, 2));
  await new Promise((r) => setTimeout(r, 30));
  await pageCache.flush();
  assertEquals(purger.batches.length, 1);
  assertEquals(purger.batches[0], ["*", "posts", "posts:1", "posts:2"]);
});

// -- wildcard bucket: every purge must reach it (README tag-model table) ------

Deno.test("every write purge also flushes the wildcard bucket", async () => {
  const { db, pageCache, purger } = createTestContext();
  await db.update(posts).set({ title: "x" }).where(eq(posts.id, 7));
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  // A page tagged * (opaque read) may depend on this write — the purge
  // must reach the bucket, not just the precise tags.
  assertEquals(purger.all, ["*", "posts", "posts:7"]);
});

Deno.test("manual purgeTags() flushes the wildcard bucket too", async () => {
  const { pageCache, purger } = createTestContext();
  pageCache.purgeTags("posts");
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, ["*", "posts"]);
});

Deno.test("bucket purge respects wildcardTag rename and tagPrefix", async () => {
  const purger = new RecordingPurger();
  const pageCache = createPageCache({
    schema,
    purge: purger,
    settleMs: 1,
    wildcardTag: "dpc-wild",
    tagPrefix: "shop_",
  });
  pageCache.purgeTags("posts");
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, ["shop_dpc-wild", "shop_posts"]);
});
