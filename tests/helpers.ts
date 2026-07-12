// Shared test setup: in-memory node:sqlite behind drizzle's sqlite-proxy
// driver, a small schema with a unique column and a relation, and a PageCache
// wired to a recording purger.

import { DatabaseSync } from "node:sqlite";
import { relations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createPageCache, DEFAULT_ALL_TAG } from "../page_cache.ts";
import type { Purger } from "../types.ts";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
});

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body"),
  authorId: integer("author_id").notNull().references(() => users.id),
});

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));
export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));

export const schema = { users, posts, usersRelations, postsRelations };

export class RecordingPurger implements Purger {
  batches: string[][] = [];
  // deno-lint-ignore require-await
  async purge(tags: readonly string[]): Promise<void> {
    this.batches.push([...tags].sort());
  }
  get all(): string[] {
    return this.batches.flat().sort();
  }
}

export function createTestContext(options: { settleMs?: number } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      author_id INTEGER NOT NULL REFERENCES users(id)
    );
  `);
  const insertUser = sqlite.prepare(
    "INSERT INTO users (email, name) VALUES (?, ?)",
  );
  const insertPost = sqlite.prepare(
    "INSERT INTO posts (title, body, author_id) VALUES (?, ?, ?)",
  );
  for (let i = 1; i <= 3; i++) {
    insertUser.run(`user${i}@example.com`, `User ${i}`);
  }
  for (let i = 1; i <= 10; i++) {
    insertPost.run(`Post ${i}`, `Body ${i}`, ((i - 1) % 3) + 1);
  }

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
      const rows = stmt.all(...(params as never[]));
      return {
        rows: rows.map((r) => Object.values(r as Record<string, unknown>)),
      };
    },
    { schema },
  );

  const purger = new RecordingPurger();
  const pageCache = createPageCache({
    schema,
    purger,
    settleMs: options.settleMs ?? 1,
  });
  const db = pageCache.wrap(raw);

  return { db, raw, pageCache, purger, sqlite };
}

/** Run a read inside a request scope and return the tags it produced.
 * Filters the ever-present all-pages tag — these tests are about
 * derivation; the stamp itself is covered in middleware_test.ts. */
export async function tagsFor(
  pageCache: ReturnType<typeof createTestContext>["pageCache"],
  fn: () => Promise<unknown>,
): Promise<string[]> {
  let captured = "";
  const handler = pageCache.middleware(async () => {
    await fn();
    return new Response("ok");
  });
  const res = await handler(new Request("http://localhost/page"));
  captured = res.headers.get("Surrogate-Key") ?? "";
  return captured === ""
    ? []
    : captured.split(" ").filter((t) => t !== DEFAULT_ALL_TAG).sort();
}
