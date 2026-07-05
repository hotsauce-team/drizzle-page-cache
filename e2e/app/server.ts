// Deno entry for the e2e app.
import { createHandler } from "./app.ts";
import { exec } from "./db-node.ts";

Deno.serve({ port: 8000, hostname: "0.0.0.0" }, createHandler(exec));
