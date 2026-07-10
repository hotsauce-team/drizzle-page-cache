import { assertEquals, assertRejects } from "@std/assert";
import { eq } from "drizzle-orm";
import { createTestContext, posts } from "./helpers.ts";

Deno.test("transaction: purges flush only after commit, as one batch", async () => {
  const { db, pageCache, purger } = createTestContext({ settleMs: 5 });
  await db.transaction(async (tx) => {
    await tx.update(posts).set({ title: "a" }).where(eq(posts.id, 1));
    await tx.update(posts).set({ title: "b" }).where(eq(posts.id, 2));
    // nothing purged mid-transaction
    assertEquals(purger.batches.length, 0);
  });
  await new Promise((r) => setTimeout(r, 10));
  await pageCache.flush();
  assertEquals(purger.batches.length, 1);
  assertEquals(purger.batches[0], ["*", "posts", "posts:1", "posts:2"]);
});

Deno.test("transaction: rollback drops buffered purges", async () => {
  const { db, pageCache, purger } = createTestContext({ settleMs: 5 });
  await assertRejects(() =>
    db.transaction(async (tx) => {
      await tx.update(posts).set({ title: "x" }).where(eq(posts.id, 3));
      throw new Error("rollback");
    })
  );
  await new Promise((r) => setTimeout(r, 10));
  await pageCache.flush();
  assertEquals(purger.batches.length, 0);
});

Deno.test("transaction: reads inside a tx still tag the request scope", async () => {
  const { db, pageCache } = createTestContext();
  const handler = pageCache.middleware(async () => {
    await db.transaction(async (tx) => {
      await tx.select().from(posts).where(eq(posts.id, 5));
    });
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("Surrogate-Key"), "posts:5");
});
