// The purge method family: purge() / purgeAll() are immediate and REJECT on
// purger failure (deploy hooks); purgeBatch() joins the settled batch and
// never throws. The all-pages tag is stamped on every tagged response but
// never purged automatically.

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { eq } from "drizzle-orm";
import { createPageCache } from "../src/page_cache.ts";
import type { PageCacheEvent } from "../src/types.ts";
import {
  createTestContext,
  posts,
  RecordingPurger,
  schema,
} from "./helpers.ts";

Deno.test("purge(): sends immediately (no settle wait), draining the pending batch", async () => {
  const { db, pageCache, purger } = createTestContext({ settleMs: 5000 });
  await db.update(posts).set({ title: "x" }).where(eq(posts.id, 3)); // pending
  await pageCache.purge("static");
  assertEquals(purger.batches.length, 1); // one send, no 5s wait
  assertEquals(purger.batches[0], [
    "dpc-unknown",
    "posts",
    "posts:3",
    "static",
  ]);
});

Deno.test("purge(): rejects on purger failure AND emits purge-error", async () => {
  const events: PageCacheEvent[] = [];
  const pageCache = createPageCache({
    schema,
    purger: {
      // deno-lint-ignore require-await
      purge: async () => {
        throw new Error("endpoint down");
      },
    },
    onEvent: (e) => events.push(e),
  });
  await assertRejects(() => pageCache.purge("posts"), Error, "endpoint down");
  assertEquals(events.filter((e) => e.kind === "purge-error").length, 1);
});

Deno.test("purge() with no tags reports the most recent send's failure", async () => {
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
  });
  const db = pageCache.wrap(base.raw);
  await db.insert(posts).values({ title: "t", body: "b", authorId: 1 });
  await new Promise((r) => setTimeout(r, 10)); // settle timer drains, fails silently
  // "Flush and fail loudly": the drained-and-failed batch must not read as
  // success just because pending is empty again.
  await assertRejects(() => pageCache.purge(), Error, "endpoint down");
});

Deno.test("purgeAll(): one send of the all-pages tag, prefixed", async () => {
  const purger = new RecordingPurger();
  const pageCache = createPageCache({ schema, purger, tagPrefix: "shop_" });
  await pageCache.purgeAll();
  assertEquals(purger.batches[0], ["shop_dpc-all", "shop_dpc-unknown"]);
});

Deno.test("the all-pages tag never rides automatic purge batches", async () => {
  const { db, pageCache, purger } = createTestContext();
  await db.update(posts).set({ title: "x" }).where(eq(posts.id, 3));
  pageCache.purgeBatch("custom");
  await new Promise((r) => setTimeout(r, 5));
  await pageCache.flush();
  assertEquals(purger.all.includes("dpc-all"), false);
});

Deno.test("allTag collisions are rejected at init", () => {
  const purger = new RecordingPurger();
  assertThrows(
    () => createPageCache({ schema, purger, allTag: "posts" }),
    Error,
    "collides",
  );
  assertThrows(
    () => createPageCache({ schema, purger, allTag: "dpc-unknown" }),
    Error,
    "must differ",
  );
});
