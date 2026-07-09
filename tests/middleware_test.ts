import { assertEquals, assertStringIncludes } from "@std/assert";
import { eq } from "drizzle-orm";
import { createPageCache } from "../page_cache.ts";
import { createTestContext, posts, RecordingPurger, schema } from "./helpers.ts";

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

Deno.test("GET with Set-Cookie is not tagged (personalized response)", async () => {
  const { db, pageCache } = createTestContext();
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).where(eq(posts.id, 3));
    return new Response("hi", { headers: { "Set-Cookie": "sid=abc" } });
  });
  const res = await handler(new Request("http://localhost/post/3"));
  assertEquals(res.headers.get("Surrogate-Key"), null);
  assertEquals(res.headers.get("Cache-Control"), null);
});

Deno.test("GET with Cache-Control: private is not tagged", async () => {
  const { db, pageCache } = createTestContext();
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).where(eq(posts.id, 3));
    return new Response("hi", {
      headers: { "Cache-Control": "private, max-age=60" },
    });
  });
  const res = await handler(new Request("http://localhost/post/3"));
  assertEquals(res.headers.get("Surrogate-Key"), null);
  // the app's own directive is left untouched
  assertEquals(res.headers.get("Cache-Control"), "private, max-age=60");
});

Deno.test('GET with qualified Cache-Control: no-cache="set-cookie" is not tagged', async () => {
  const { db, pageCache } = createTestContext();
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).where(eq(posts.id, 3));
    return new Response("hi", {
      headers: { "Cache-Control": 'no-cache="set-cookie", max-age=60' },
    });
  });
  const res = await handler(new Request("http://localhost/post/3"));
  assertEquals(res.headers.get("Surrogate-Key"), null);
});

Deno.test("purge-echo route gates on method and token", async () => {
  const pageCache = createPageCache({
    schema,
    purge: new RecordingPurger(),
    purgeEcho: { token: "s3cret", path: "/__echo" },
  });
  const handler = pageCache.middleware(() => new Response("app"));

  const put = await handler(
    new Request("http://localhost/__echo?token=s3cret", { method: "PUT" }),
  );
  assertEquals(put.status, 405);
  assertEquals(put.headers.get("Allow"), "GET, POST");

  const bad = await handler(new Request("http://localhost/__echo?token=nope"));
  assertEquals(bad.status, 403);

  const ok = await handler(
    new Request("http://localhost/__echo?token=s3cret&tags=posts:1"),
  );
  assertEquals(ok.status, 200);
  assertEquals(ok.headers.get("X-LiteSpeed-Purge"), "tag=posts:1");
});

Deno.test("no built-in path exclusion: a clean GET under /admin is tagged", async () => {
  const { db, pageCache } = createTestContext();
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).limit(1);
    return new Response("admin list");
  });
  const res = await handler(new Request("http://localhost/admin/posts"));
  assertEquals(res.headers.get("Surrogate-Key"), "posts");
});

Deno.test("custom shouldTag can exclude paths", async () => {
  const { db, pageCache } = createTestContext({
    shouldTag: (req, res) =>
      req.method === "GET" && res.ok &&
      !new URL(req.url).pathname.startsWith("/admin/"),
  });
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).limit(1);
    return new Response("list");
  });
  const admin = await handler(new Request("http://localhost/admin/posts"));
  assertEquals(admin.headers.get("Surrogate-Key"), null);
  const pub = await handler(new Request("http://localhost/posts"));
  assertEquals(pub.headers.get("Surrogate-Key"), "posts");
});

Deno.test("safety gate wins over a permissive shouldTag", async () => {
  const { db, pageCache } = createTestContext({ shouldTag: () => true });
  const handler = pageCache.middleware(async (req) => {
    await db.select().from(posts).limit(1);
    return new URL(req.url).pathname === "/cookie"
      ? new Response("hi", { headers: { "Set-Cookie": "sid=abc" } })
      : new Response("hi", { headers: { "Cache-Control": "private" } });
  });
  const cookie = await handler(new Request("http://localhost/cookie"));
  assertEquals(cookie.headers.get("Surrogate-Key"), null);
  const priv = await handler(new Request("http://localhost/private"));
  assertEquals(priv.headers.get("Surrogate-Key"), null);
  assertEquals(priv.headers.get("Cache-Control"), "private");
});

Deno.test("shouldTag widened to 404s tags an entity miss", async () => {
  const { db, pageCache } = createTestContext({
    shouldTag: (req, res) =>
      req.method === "GET" && (res.ok || res.status === 404),
  });
  const handler = pageCache.middleware(async () => {
    await db.select().from(posts).where(eq(posts.id, 999));
    return new Response("not found", { status: 404 });
  });
  const res = await handler(new Request("http://localhost/post/999"));
  // miss on unique equality → row tag + table tag, so creating post 999
  // later purges this cached 404
  assertEquals(res.headers.get("Surrogate-Key"), "posts:999 posts");
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
