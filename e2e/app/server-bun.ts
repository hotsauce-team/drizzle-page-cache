// Bun entry for the e2e app. Bun.serve speaks Request/Response natively,
// so unlike Node there is no adapter at all. Runs only in a container
// (oven/bun) — see docker-compose.yml.

import { createHandler } from "./app.ts";
import { exec } from "./db-bun.ts";

// deno-lint-ignore no-explicit-any
(globalThis as any).Bun.serve({
  port: 8000,
  hostname: "0.0.0.0",
  fetch: createHandler(exec),
});

console.log("bun e2e app listening on :8000");
