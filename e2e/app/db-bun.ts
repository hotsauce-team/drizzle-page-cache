// bun:sqlite backend — Bun has no node:sqlite (verified 1.3.14), but its own
// module has the same shape. Statement.values() returns value arrays, which
// is exactly what sqlite-proxy wants.

// deno-lint-ignore no-external-import
import { Database } from "bun:sqlite";
import { SETUP_SQL, type SqliteExec } from "./app.ts";

const sqlite = new Database(":memory:");
for (const stmt of SETUP_SQL) sqlite.run(stmt);

// sqlite-proxy expects an async callback; bun:sqlite itself is sync
// deno-lint-ignore require-await
export const exec: SqliteExec = async (query, params, method) => {
  const stmt = sqlite.query(query);
  if (method === "run") {
    stmt.run(...(params as never[]));
    return { rows: [] };
  }
  const rows = stmt.values(...(params as never[]));
  if (method === "get") return { rows: rows[0] ?? [] };
  return { rows };
};
