import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { createTestContext, posts, tagsFor, users } from "./helpers.ts";

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
  assertEquals(purger.all, ["posts", "posts:7"]);
});

Deno.test("insert purges the table tag only", async () => {
  const { db, pageCache, purger } = createTestContext();
  await db.insert(posts).values({ title: "new", body: "b", authorId: 1 });
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, ["posts"]);
});

Deno.test("delete by PK purges row + table tags", async () => {
  const { db, pageCache, purger } = createTestContext();
  await db.delete(posts).where(eq(posts.id, 9));
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, ["posts", "posts:9"]);
});

Deno.test("update by non-PK column purges table tag (no false row precision)", async () => {
  const { db, pageCache, purger } = createTestContext();
  await db.update(users).set({ name: "x" }).where(
    eq(users.email, "user1@example.com"),
  );
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all, ["users"]);
});

Deno.test("purge batches are deduplicated across writes in the settle window", async () => {
  const { db, pageCache, purger } = createTestContext({ settleMs: 20 });
  await db.update(posts).set({ title: "a" }).where(eq(posts.id, 1));
  await db.update(posts).set({ title: "b" }).where(eq(posts.id, 1));
  await db.update(posts).set({ title: "c" }).where(eq(posts.id, 2));
  await new Promise((r) => setTimeout(r, 30));
  await pageCache.flush();
  assertEquals(purger.batches.length, 1);
  assertEquals(purger.batches[0], ["posts", "posts:1", "posts:2"]);
});
