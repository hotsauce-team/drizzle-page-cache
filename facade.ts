// Transparent facade over a drizzle db instance. Passes the drizzle API
// through unchanged while deriving read tags (from results) and write purges
// (from statement type + WHERE walking). See SPEC.md for the tag model.

import { getTableName, is, Table } from "drizzle-orm";
import {
  findUniqueEqs,
  rowTag,
  type SchemaInfo,
  type UniqueEq,
} from "./derive.ts";

export interface FacadeContext {
  info: SchemaInfo;
  /** Wire name of the unknown-bucket tag — what opaque reads/writes emit.
   * Guaranteed distinct from every table name (checked at init), so it
   * doubles as the "this was opaque" marker in comparisons below. */
  unknownTag: string;
  addTags(tags: Iterable<string>): void;
  schedulePurge(tags: Iterable<string>): void;
  /** Observability: unobserved-read / unobserved-write signals (see types.ts). */
  emit(kind: "unobserved-read" | "unobserved-write", reason: string): void;
}

const JOIN_METHODS = new Set([
  "from",
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "crossJoin",
]);
const EXEC_METHODS = new Set(["execute", "all", "get", "values", "run"]);

// deno-lint-ignore no-explicit-any
type Any = any;

export function wrapDb<TDb>(db: TDb, ctx: FacadeContext): TDb {
  return new Proxy(db as object, {
    get(target: Any, prop, receiver) {
      switch (prop) {
        case "select":
        case "selectDistinct":
          return (...args: Any[]) => wrapRead(target[prop](...args), ctx);
        case "insert":
          return (...args: Any[]) =>
            wrapWrite(
              target.insert(...args),
              ctx,
              tableTagOf(args[0], ctx),
              false,
            );
        case "update":
          return (...args: Any[]) =>
            wrapWrite(
              target.update(...args),
              ctx,
              tableTagOf(args[0], ctx),
              true,
            );
        case "delete":
          return (...args: Any[]) =>
            wrapWrite(
              target.delete(...args),
              ctx,
              tableTagOf(args[0], ctx),
              true,
            );
        case "query":
          return wrapRelational(target.query, ctx);
        case "transaction":
          return (fn: Any, config: Any) =>
            runTransaction(target, fn, config, ctx);
        default: {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }
    },
  }) as TDb;
}

function tableTagOf(table: unknown, ctx: FacadeContext): string {
  return is(table, Table) ? getTableName(table) : ctx.unknownTag;
}

// -- builder-chain wrapping ----------------------------------------------------

/**
 * Drizzle builders chain in two ways: by returning `this` (most sqlite/pg
 * chain methods) and by constructing a NEW builder (`select().from()`,
 * `update().set()`, `.prepare()`). Both must stay observed, so anything
 * builder-shaped coming out of a call gets re-wrapped in the same closure.
 */
function isBuilderLike(value: unknown): boolean {
  if (
    value === null || (typeof value !== "object" && typeof value !== "function")
  ) return false;
  const v = value as Any;
  return typeof v.then === "function" || typeof v.where === "function" ||
    typeof v.execute === "function";
}

function wrapChain(
  builder: Any,
  tap: (result: unknown) => unknown,
  onMethod: (prop: string, args: Any[]) => void,
): Any {
  const wrapNode = (node: Any): Any =>
    new Proxy(node, {
      get(target: Any, prop) {
        if (prop === "then") {
          return (onFulfilled?: Any, onRejected?: Any) =>
            target.then(
              (r: unknown) => (onFulfilled ?? ((x: unknown) => x))(tap(r)),
              onRejected,
            );
        }
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        if (EXEC_METHODS.has(prop as string)) {
          return (...args: Any[]) =>
            Promise.resolve(value.apply(target, args)).then(tap);
        }
        return (...args: Any[]) => {
          onMethod(prop as string, args);
          const out = value.apply(target, args);
          if (out === target) return wrapNode(target);
          return isBuilderLike(out) ? wrapNode(out) : out;
        };
      },
    });
  return wrapNode(builder);
}

// -- reads (core builder) -----------------------------------------------------

function wrapRead(builder: Any, ctx: FacadeContext): Any {
  const tables = new Set<string>();
  const uniques: UniqueEq[] = [];

  return wrapChain(
    builder,
    (result) => {
      const tags = readTags(result, tables, uniques, ctx);
      if (tags.has(ctx.unknownTag)) {
        ctx.emit(
          "unobserved-read",
          tables.size === 0
            ? "select with no observed from()"
            : "non-table from()/join argument",
        );
      }
      ctx.addTags(tags);
      return result;
    },
    (prop, args) => {
      if (JOIN_METHODS.has(prop)) tables.add(tableTagOf(args[0], ctx));
      if (prop === "where") uniques.push(...findUniqueEqs(args[0]));
    },
  );
}

/** The entity/list split. See SPEC.md — read tags derive from results. */
function readTags(
  result: unknown,
  tables: ReadonlySet<string>,
  uniques: readonly UniqueEq[],
  ctx: FacadeContext,
): Set<string> {
  const tags = new Set<string>();
  const rows = result === undefined || result === null
    ? []
    : Array.isArray(result)
    ? result
    : [result];

  const primary = tables.values().next().value as string | undefined;
  const unique = uniques.find((u) => u.tableName === primary);

  if (
    primary !== undefined && primary !== ctx.unknownTag && unique &&
    rows.length <= 1
  ) {
    // Entity read: row tag; on a miss also the table tag so a future
    // insert invalidates a cached 404.
    const pkKey = ctx.info.pkKeyByTable.get(primary);
    const row = rows[0] as Record<string, unknown> | undefined;
    const pkValue = unique.viaPk ? unique.value : row?.[pkKey ?? ""];
    if (pkValue !== undefined) {
      tags.add(rowTag(primary, pkValue));
      if (rows.length === 0) tags.add(primary);
    } else {
      tags.add(primary); // partial select omitted the PK — degrade safely
    }
    // Joined tables are list-level dependencies either way.
    for (const t of tables) if (t !== primary) tags.add(t);
    return tags;
  }

  if (tables.size === 0) tags.add(ctx.unknownTag);
  for (const t of tables) tags.add(t);
  return tags;
}

// -- writes ---------------------------------------------------------------------

function wrapWrite(
  builder: Any,
  ctx: FacadeContext,
  tableTag: string,
  rowPrecise: boolean,
): Any {
  const uniques: UniqueEq[] = [];

  return wrapChain(
    builder,
    (result) => {
      const tags = new Set<string>([tableTag]);
      if (tableTag === ctx.unknownTag) {
        ctx.emit("unobserved-write", "write against a non-table target");
      }
      if (rowPrecise) {
        for (const u of uniques) {
          if (u.viaPk && u.tableName === tableTag) {
            tags.add(rowTag(u.tableName, u.value));
          }
        }
      }
      ctx.schedulePurge(tags);
      return result;
    },
    (prop, args) => {
      if (prop === "where") uniques.push(...findUniqueEqs(args[0]));
    },
  );
}

// -- relational API (db.query.*) --------------------------------------------------

function wrapRelational(query: Any, ctx: FacadeContext): Any {
  return new Proxy(query, {
    get(target: Any, tsKey) {
      const value = Reflect.get(target, tsKey);
      if (typeof tsKey !== "string" || value === undefined || value === null) {
        return value;
      }
      const tableName = ctx.info.tableByKey.get(tsKey);
      if (tableName === undefined) return value;
      return new Proxy(value, {
        get(builder: Any, method) {
          const fn = Reflect.get(builder, method);
          if (method !== "findMany" && method !== "findFirst") {
            return typeof fn === "function" ? fn.bind(builder) : fn;
          }
          return (config: Any) => {
            const tables = new Set<string>([tableName]);
            for (const relKey of Object.keys(config?.with ?? {})) {
              const related = ctx.info.relationsByKey.get(tsKey)?.get(relKey);
              if (related === undefined) {
                ctx.emit(
                  "unobserved-read",
                  `unresolvable relation '${tsKey}.${relKey}'`,
                );
              }
              tables.add(related ?? ctx.unknownTag);
            }
            // Callback-form `where` can't be walked structurally → list read.
            const uniques = config?.where && typeof config.where !== "function"
              ? findUniqueEqs(config.where)
              : [];
            return fn.call(builder, config).then((result: unknown) => {
              ctx.addTags(readTags(result, tables, uniques, ctx));
              return result;
            });
          };
        },
      });
    },
  });
}

// -- transactions ------------------------------------------------------------------

async function runTransaction(
  target: Any,
  fn: Any,
  config: Any,
  ctx: FacadeContext,
) {
  // Buffer purges; flush only after commit, drop on rollback (SPEC.md).
  const buffered = new Set<string>();
  const txCtx: FacadeContext = {
    ...ctx,
    schedulePurge: (tags) => {
      for (const t of tags) buffered.add(t);
    },
  };
  const result = await target.transaction(
    (tx: Any) => fn(wrapDb(tx, txCtx)),
    config,
  );
  ctx.schedulePurge(buffered);
  return result;
}
