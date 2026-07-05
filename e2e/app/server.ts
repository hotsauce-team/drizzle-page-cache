// Deno entry for the e2e app.
import { handler } from "./app.ts";

Deno.serve({ port: 8000, hostname: "0.0.0.0" }, handler);
