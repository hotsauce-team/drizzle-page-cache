// Runtime-neutral e2e app: node:sqlite + drizzle + this package.
// Runs unmodified on Deno (server.ts) and Node 24+ (server-node.ts) —
// both runtimes ship `node:sqlite` and strip types natively.
// Routes: GET / (list), GET /post/:id (entity), POST /edit/:id (write → purge).

import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createPageCache, souinPurger } from "../../mod.ts";

const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
});
const schema = { posts };

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(
  "CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);",
);
const seed = sqlite.prepare("INSERT INTO posts (title) VALUES (?)");
for (let i = 1; i <= 5; i++) seed.run(`Post ${i}`);

const pageCache = createPageCache({
  schema,
  ttl: 300,
  settleMs: 10,
  purge: souinPurger(
    process.env.PURGE_URL ?? "http://caddy/souin-api/souin",
  ),
});

const raw = drizzle(
  // sqlite-proxy expects an async callback; node:sqlite itself is sync
  // deno-lint-ignore require-await
  async (query: string, params: unknown[], method: string) => {
    const stmt = sqlite.prepare(query);
    if (method === "run") {
      stmt.run(...(params as never[]));
      return { rows: [] };
    }
    if (method === "get") {
      const row = stmt.get(...(params as never[]));
      return { rows: row ? Object.values(row) : [] };
    }
    return {
      rows: stmt.all(...(params as never[])).map((r) =>
        Object.values(r as object)
      ),
    };
  },
  { schema },
);

const db = pageCache.wrap(raw);

const html = (body: string) =>
  new Response(
    `<!doctype html><body>${body} <small>rendered ${Date.now()}</small></body>`,
    { headers: { "content-type": "text/html" } },
  );

async function app(req: Request): Promise<Response> {
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
  if (edit && req.method === "POST") {
    const title = (await req.formData()).get("title") as string ?? "edited";
    await db.update(posts).set({ title }).where(eq(posts.id, Number(edit[1])));
    return new Response("ok");
  }
  return new Response("not found", { status: 404 });
}

export const handler = pageCache.middleware(app);
