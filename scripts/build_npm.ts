// Build the npm package with dnt. Usage: deno task build:npm [version]

import { build, emptyDir } from "@deno/dnt";

const version = Deno.args[0] ??
  JSON.parse(Deno.readTextFileSync("deno.json")).version;

await emptyDir("./npm");

await build({
  entryPoints: [
    "./mod.ts",
    { name: "./litespeed", path: "./litespeed/mod.ts" },
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
  },
  postBuild() {
    Deno.copyFileSync("LICENSE", "npm/LICENSE");
    Deno.copyFileSync("README.md", "npm/README.md");
  },
});
