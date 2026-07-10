// Guard test: the facade/derive layer rides drizzle's exported-but-internal
// SQL shape (queryChunks / Column / StringChunk / Param) and getTableColumns'
// `.primary` flag. A drizzle release that reshapes these would SILENTLY
// degrade tag precision (safe-direction, but quiet). Assert the shapes here so
// a version bump breaks CI loudly instead of production tags. See derive.ts.

import { assert, assertEquals } from "@std/assert";
import {
  Column,
  eq,
  getTableColumns,
  is,
  Param,
  SQL,
  StringChunk,
} from "drizzle-orm";
import { posts } from "./helpers.ts";

Deno.test("drizzle internals: eq() walks as [Column, '=', Param]", () => {
  const expr = eq(posts.id, 7);
  assert(is(expr, SQL), "eq() should produce an SQL object");
  const chunks = (expr as SQL).queryChunks;

  const colIdx = chunks.findIndex((c) => is(c, Column));
  assert(colIdx >= 0, "expected a Column chunk in the WHERE tree");

  // The string chunks after the Column must amount to '='.
  let j = colIdx + 1;
  let text = "";
  while (j < chunks.length && is(chunks[j], StringChunk)) {
    text += (chunks[j] as StringChunk).value.join("");
    j++;
  }
  assertEquals(text.trim(), "=");

  assert(is(chunks[j], Param), "expected a Param after the '=' operator");
  assertEquals((chunks[j] as Param).value, 7);
});

Deno.test("drizzle internals: getTableColumns exposes the primary-key column", () => {
  const cols = getTableColumns(posts);
  const pkEntry = Object.entries(cols).find(([, c]) =>
    (c as Column).primary
  );
  assert(pkEntry, "expected getTableColumns to flag a primary-key column");
  assertEquals(pkEntry![0], "id");
});
