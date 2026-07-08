// Build the npm package with dnt. Usage: deno task build:npm [version]

import { build, emptyDir } from "@deno/dnt";

const version = Deno.args[0] ??
  JSON.parse(Deno.readTextFileSync("deno.json")).version;

await emptyDir("./npm");

await build({
  entryPoints: [
    "./mod.ts",
    { name: "./litespeed", path: "./litespeed/mod.ts" },
    { name: "./souin", path: "./souin/mod.ts" },
    { name: "./surrogate-key", path: "./surrogate-key/mod.ts" },
    { name: "./xkey", path: "./xkey/mod.ts" },
    { name: "./varnish", path: "./varnish/mod.ts" },
    { name: "./angie", path: "./angie/mod.ts" },
    { name: "./nginx", path: "./nginx/mod.ts" },
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
