// Structural tag derivation — exported drizzle API only, no SQL-string parsing.
// See SPEC.md "Verified constraints" for why these are the seams.

import {
  Column,
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  getTableColumns,
  getTableName,
  is,
  Param,
  SQL,
  StringChunk,
  Table,
} from "drizzle-orm";

export interface SchemaInfo {
  /** TS schema key → SQL table name, for RQB property-path lookup. */
  tableByKey: Map<string, string>;
  /** SQL table name → TS property key of its primary-key column. */
  pkKeyByTable: Map<string, string>;
  /** TS schema key → (relation key → referenced SQL table name). */
  relationsByKey: Map<string, Map<string, string>>;
}

export function analyzeSchema(schema: Record<string, unknown>): SchemaInfo {
  const tableByKey = new Map<string, string>();
  const pkKeyByTable = new Map<string, string>();
  const relationsByKey = new Map<string, Map<string, string>>();

  for (const [key, value] of Object.entries(schema)) {
    if (!is(value, Table)) continue;
    const name = getTableName(value);
    tableByKey.set(key, name);
    for (const [colKey, col] of Object.entries(getTableColumns(value))) {
      if ((col as Column).primary) {
        pkKeyByTable.set(name, colKey);
        break;
      }
    }
  }

  // Relation key → referenced table, resolved the same way drizzle does
  // internally (both helpers are exported API).
  try {
    const relational = extractTablesRelationalConfig(
      schema,
      createTableRelationsHelpers,
    );
    for (const [key, tableConfig] of Object.entries(relational.tables)) {
      const map = new Map<string, string>();
      for (const [relKey, rel] of Object.entries(tableConfig.relations)) {
        map.set(
          relKey,
          getTableName((rel as { referencedTable: Table }).referencedTable),
        );
      }
      if (map.size > 0) relationsByKey.set(key, map);
    }
  } catch {
    // No relations in schema (or drizzle internals moved) — `with:` queries
    // will degrade to the unknown-bucket tag rather than silently under-tag.
  }

  return { tableByKey, pkKeyByTable, relationsByKey };
}

export interface UniqueEq {
  tableName: string;
  /** True when the equality is on the primary key (value usable as row tag). */
  viaPk: boolean;
  value: unknown;
}

/**
 * Walk a WHERE expression (an SQL object tree) for equalities on primary-key
 * or unique columns: the chunk pattern `Column, '=', Param`.
 */
export function findUniqueEqs(where: unknown): UniqueEq[] {
  const found: UniqueEq[] = [];
  walk(where, found);
  return found;
}

function walk(node: unknown, out: UniqueEq[]): void {
  if (!is(node, SQL)) return;
  const chunks = node.queryChunks;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (is(chunk, SQL)) {
      walk(chunk, out);
      continue;
    }
    if (!is(chunk, Column)) continue;
    const col = chunk as Column & { isUnique?: boolean };
    if (!col.primary && !col.isUnique) continue;

    // Scan forward over string chunks; accept iff they amount to '='.
    let j = i + 1;
    let text = "";
    while (j < chunks.length && is(chunks[j], StringChunk)) {
      text += (chunks[j] as StringChunk).value.join("");
      j++;
    }
    if (text.trim() !== "=" || j >= chunks.length) continue;
    const rhs = chunks[j];
    if (!is(rhs, Param)) continue;

    out.push({
      tableName: getTableName(col.table),
      viaPk: col.primary === true,
      value: (rhs as Param).value,
    });
  }
}

export const rowTag = (table: string, value: unknown): string =>
  `${table}:${value}`;
