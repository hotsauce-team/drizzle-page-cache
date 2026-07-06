// Runtime-neutral e2e app: drizzle + this package, with the sqlite backend
// injected per runtime (db-node.ts for Deno/Node, db-bun.ts for Bun — Bun
// has no node:sqlite as of 1.3.x).
// Routes: GET / (list), GET /post/:id (entity), POST /edit/:id (write → purge).

import process from "node:process";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createPageCache, souinPurger } from "../../mod.ts";
import { createPageCache as createLiteSpeedPageCache } from "../../litespeed/mod.ts";
import type { Handler } from "../../types.ts";

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
});
const schema = { posts };

export const SETUP_SQL = [
  "CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);",
  ...Array.from(
    { length: 5 },
    (_, i) => `INSERT INTO posts (title) VALUES ('Post ${i + 1}');`,
  ),
];

/** The sqlite-proxy driver callback shape a runtime db module must provide. */
export type SqliteExec = (
  query: string,
  params: unknown[],
  method: string,
) => Promise<{ rows: unknown[] }>;

export function createHandler(exec: SqliteExec): Handler {
  // PURGE_STYLE=litespeed dogfoods the drizzle-page-cache/litespeed
  // entrypoint (header-driven purging); default is the Souin PURGE API.
  const litespeed = process.env.PURGE_STYLE === "litespeed";
  const token = process.env.PURGE_TOKEN ?? "e2e-secret";

  const pageCache = litespeed
    ? createLiteSpeedPageCache({
      schema,
      ttl: 300,
      settleMs: 10,
      site: process.env.PURGE_SITE ?? "http://ols",
      token,
    })
    : createPageCache({
      schema,
      ttl: 300,
      settleMs: 10,
      purge: souinPurger(
        process.env.PURGE_URL ?? "http://caddy/souin-api/souin",
      ),
    });

  const db = pageCache.wrap(drizzle(exec, { schema }));

  const html = (body: string) =>
    new Response(
      `<!doctype html><body>${body} <small>rendered ${Date.now()}</small></body>`,
      { headers: { "content-type": "text/html" } },
    );

  return pageCache.middleware(async (req) => {
    const url = new URL(req.url);
    const detail = url.pathname.match(/^\/post\/(\d+)$/);
    const edit = url.pathname.match(/^\/edit\/(\d+)$/);

    if (url.pathname === "/") {
      const rows = await db.select().from(posts);
      return html(
        rows.map((p) => `<a href="/post/${p.id}">${p.title}</a>`).join(" "),
      );
    }
    if (detail) {
      const [post] = await db.select().from(posts).where(
        eq(posts.id, Number(detail[1])),
      );
      return post
        ? html(`<h1>${post.title}</h1>`)
        : new Response("not found", { status: 404 });
    }
    // Bench route: same work as a detail page, never cacheable — lives under
    // the excluded /admin prefix (middleware adds no cache headers there) and
    // sends no-store explicitly, so every proxy passes it through. Measures
    // pure proxy passthrough overhead on cache misses.
    // Bench probe: identical work, but plain `max-age` instead of the
    // browser-safe `max-age=0, s-maxage=N` split. Exists to test caches
    // whose RFC 7234 support is incomplete (Envoy's alpha filter ignores
    // s-maxage — see BENCHMARKS.md).
    if (url.pathname === "/admin/plainmax") {
      const [post] = await db.select().from(posts).where(eq(posts.id, 3));
      const res = html(`<h1>${post?.title ?? "?"}</h1>`);
      res.headers.set("Cache-Control", "public, max-age=300");
      // Envoy's cache filter appears to require a validator — see BENCHMARKS.md
      res.headers.set("ETag", '"bench-static"');
      return res;
    }
    // Bench probe: sandbox-identical conditions — NO Vary header (Deno only
    // adds Vary: Accept-Encoding for compressible content types).
    if (url.pathname === "/admin/novary") {
      return new Response(`novary ${Date.now()}`, {
        headers: {
          "content-type": "application/octet-stream",
          "cache-control": "public, max-age=300",
          "etag": '"bench-novary"',
        },
      });
    }
    if (url.pathname === "/admin/uncached") {
      const [post] = await db.select().from(posts).where(eq(posts.id, 3));
      const res = html(`<h1>${post?.title ?? "?"}</h1>`);
      res.headers.set("Cache-Control", "no-store");
      return res;
    }
    if (edit && req.method === "POST") {
      const title = (await req.formData()).get("title") as string ?? "edited";
      await db.update(posts).set({ title }).where(
        eq(posts.id, Number(edit[1])),
      );
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  });
}
