import { assertEquals, assertStringIncludes } from "@std/assert";
import { eq } from "drizzle-orm";
import { createTestContext, posts } from "./helpers.ts";

Deno.test("cacheable GET gets Surrogate-Key and Cache-Control headers", async () => {
  const { db, pageCache } = createTestContext();
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).where(eq(posts.id, 3));
    return new Response("<html>post 3</html>");
  });
  const res = await handler(new Request("http://localhost/post/3"));
  assertEquals(res.headers.get("Surrogate-Key"), "posts:3");
  assertStringIncludes(res.headers.get("Cache-Control") ?? "", "max-age=0");
  assertStringIncludes(res.headers.get("Cache-Control") ?? "", "s-maxage=3600");
  assertEquals(await res.text(), "<html>post 3</html>");
});

Deno.test("POST responses are never tagged", async () => {
  const { db, pageCache } = createTestContext();
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).limit(1);
    return new Response("ok");
  });
  const res = await handler(
    new Request("http://localhost/x", { method: "POST" }),
  );
  assertEquals(res.headers.get("Surrogate-Key"), null);
  assertEquals(res.headers.get("Cache-Control"), null);
});

Deno.test("error responses are never tagged", async () => {
  const { db, pageCache } = createTestContext();
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).limit(1);
    return new Response("boom", { status: 500 });
  });
  const res = await handler(new Request("http://localhost/x"));
  assertEquals(res.headers.get("Surrogate-Key"), null);
});

Deno.test("excluded paths (default /admin) are never tagged", async () => {
  const { db, pageCache } = createTestContext();
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).limit(1);
    return new Response("admin list");
  });
  const res = await handler(new Request("http://localhost/admin/posts"));
  assertEquals(res.headers.get("Surrogate-Key"), null);
});

Deno.test("untagged responses pass through untouched", async () => {
  const { pageCache } = createTestContext();
  const original = new Response("static");
  const handler = pageCache.middleware(() => original);
  const res = await handler(new Request("http://localhost/x"));
  assertEquals(res, original); // no clone when there is nothing to add
});

Deno.test("concurrent requests get isolated tag sets", async () => {
  const { db, pageCache } = createTestContext();
  const handler = pageCache.middleware(async (req) => {
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (id > 0) {
      await new Promise((r) => setTimeout(r, id * 5));
      await db.select().from(posts).where(eq(posts.id, id));
    }
    return new Response("ok");
  });
  const [a, b, c] = await Promise.all([
    handler(new Request("http://localhost/p?id=1")),
    handler(new Request("http://localhost/p?id=2")),
    handler(new Request("http://localhost/p?id=0")),
  ]);
  assertEquals(a.headers.get("Surrogate-Key"), "posts:1");
  assertEquals(b.headers.get("Surrogate-Key"), "posts:2");
  assertEquals(c.headers.get("Surrogate-Key"), null);
});

Deno.test("manual tag() adds to the current request scope", async () => {
  const { pageCache } = createTestContext();
  const handler = pageCache.middleware(() => {
    pageCache.tag("posts:42", "custom");
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/p"));
  assertEquals(res.headers.get("Surrogate-Key")?.split(" ").sort(), [
    "custom",
    "posts:42",
  ]);
});
