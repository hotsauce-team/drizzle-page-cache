// node:sqlite backend — used by both the Deno and Node entries.

import { DatabaseSync } from "node:sqlite";
import { SETUP_SQL, type SqliteExec } from "./app.ts";

const sqlite = new DatabaseSync(":memory:");
for (const stmt of SETUP_SQL) sqlite.exec(stmt);

// sqlite-proxy expects an async callback; node:sqlite itself is sync
// deno-lint-ignore require-await
export const exec: SqliteExec = async (query, params, method) => {
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
};
