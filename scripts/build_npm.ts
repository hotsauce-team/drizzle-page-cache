// Build the npm package with dnt. Usage: deno task build:npm [version]

import { build, emptyDir } from "@deno/dnt";

const version = Deno.args[0] ??
  JSON.parse(Deno.readTextFileSync("deno.json")).version;

await emptyDir("./npm");

await build({
  entryPoints: [
    "./src/mod.ts",
    { name: "./litespeed", path: "./src/dialects/litespeed.ts" },
    { name: "./souin", path: "./src/dialects/souin.ts" },
    { name: "./surrogate-key", path: "./src/dialects/surrogate-key.ts" },
    { name: "./xkey", path: "./src/dialects/xkey.ts" },
    { name: "./varnish", path: "./src/dialects/varnish.ts" },
    { name: "./angie", path: "./src/dialects/angie.ts" },
    { name: "./nginx", path: "./src/dialects/nginx.ts" },
  ],
  outDir: "./npm",
  shims: { deno: false },
  test: false,
  typeCheck: "both",
  compilerOptions: { lib: ["ES2022", "DOM"], target: "ES2022" },
  mappings: {},
  package: {
    name: "drizzle-page-cache",
    version,
    description:
      "Tag-based HTTP page-cache invalidation for Drizzle ORM apps — Surrogate-Key headers derived from queries, purged on writes.",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/hotsauce-team/drizzle-page-cache.git",
    },
    keywords: [
      "drizzle",
      "cache",
      "surrogate-key",
      "invalidation",
      "varnish",
      "caddy",
      "souin",
    ],
    peerDependencies: { "drizzle-orm": ">=0.44.0 <1" },
    // For dnt's typecheck of `node:async_hooks` (page_cache.ts); not shipped.
    devDependencies: { "@types/node": "^22.0.0" },
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync("README.md", "npm/README.md");
    // The nginx entrypoint's Lua companions (not TS entry points):
    // Surrogate-Key dialect and LiteSpeed dialect.
    Deno.mkdirSync("npm/nginx", { recursive: true });
    Deno.copyFileSync("nginx/purge.lua", "npm/nginx/purge.lua");
    Deno.copyFileSync(
      "nginx/purge_litespeed.lua",
      "npm/nginx/purge_litespeed.lua",
    );
  },
});
