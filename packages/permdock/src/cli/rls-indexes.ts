import { createHash } from "node:crypto";

import type { Condition } from "../conditions/ast.ts";
import type { SqlConnect } from "./pg.ts";
import type { RlsSqlContext } from "./rls-sql.ts";

import { isConditionRef } from "../conditions/ast.ts";
import { connectPgPool } from "./pg.ts";
import {
  qualifiedTable,
  quoteIdent,
  quoteTable,
  scopeTable,
} from "./rls-sql.ts";

/** An index a generated policy or helper needs, its first column the one it filters on. */
export type IndexTarget = {
  readonly table: string;
  readonly columns: readonly string[];
};

/** Postgres truncates identifiers longer than this, in bytes. */
const MAX_IDENT = 63;

/**
 * The row fields `condition` compares with the subject, a claim or a
 * membership (`ownerId: principal.id`, `memberOf`), through `and` and `or`:
 * the selective comparisons an index serves. A comparison with a constant
 * (`status: 'sent'`) narrows rows the scope key already found, a negation
 * scans anyway, and a dotted field is a JSON path a plain index does not serve.
 */
export function indexedFields(condition: Condition | undefined): string[] {
  if (condition === undefined) {
    return [];
  }
  switch (condition.op) {
    case "and":
    case "or":
      return condition.conditions.flatMap(indexedFields);
    case "memberOf":
      return plainField(condition.field);
    case "eq":
    case "in":
      return isConditionRef(condition.value) ? plainField(condition.field) : [];
    case "not":
    case "sqlFunction":
    case "opaque":
    case "related":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains":
    case "notIn":
    case "isNull":
      return [];
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

function plainField(field: string): string[] {
  return field.includes(".") ? [] : [field];
}

/**
 * Every index the generated SQL reads through: the row columns policies
 * filter on (scope keys and selective condition fields), and the membership
 * tables' user column, followed by the scope column the helpers select.
 */
export function indexTargets(
  ctx: RlsSqlContext,
  rowColumns: readonly { readonly table: string; readonly column: string }[],
): readonly IndexTarget[] {
  const targets = new Map<string, IndexTarget>();
  const add = (table: string, columns: readonly string[]): void => {
    const target = { table: qualifiedTable(table), columns };
    targets.set(`${target.table}\u0000${columns[0] ?? ""}`, target);
  };
  for (const { table, column } of rowColumns) {
    add(table, [column]);
  }
  for (const scope of ctx.scopes) {
    const mapped = scopeTable(ctx, scope.name);
    if (mapped !== undefined) {
      add(mapped.table.table, [mapped.table.user, mapped.column]);
    }
  }
  for (const source of [...(ctx.sources ?? []), ...(ctx.memberSources ?? [])]) {
    add(source.sql.table, [source.sql.user]);
    const users = source.sql.userThrough;
    if (users !== undefined) {
      add(users.table, [users.key]);
    }
  }
  return [...targets.values()].toSorted((a, b) =>
    `${a.table}.${a.columns.join(",")}` < `${b.table}.${b.columns.join(",")}`
      ? -1
      : 1,
  );
}

/** A stable index name under Postgres' identifier limit. */
export function indexName(target: IndexTarget): string {
  const bare = target.table.slice(target.table.lastIndexOf(".") + 1);
  const name = `permdock_${bare}_${target.columns.join("_")}_idx`;
  if (Buffer.byteLength(name) <= MAX_IDENT) {
    return name;
  }
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `permdock_${hash}_idx`;
}

/** `create index if not exists` for every target, one per line. */
export function indexesSql(targets: readonly IndexTarget[]): string {
  return targets
    .map(
      (target) =>
        `create index if not exists ${quoteIdent(indexName(target))} on ${quoteTable(target.table)} (${target.columns.map(quoteIdent).join(", ")});`,
    )
    .join("\n");
}

/** What a database holds for the target tables: each table's columns and its indexes' key columns. */
export type TableIndexFacts = {
  readonly columns: Readonly<Record<string, readonly string[]>>;
  /** Key columns of each non-partial index in order, cut at the first expression. */
  readonly indexes: Readonly<Record<string, readonly (readonly string[])[]>>;
};

/** Every live column of the tables in `$1` (`schema.table`), as `target` and `name`. */
export const COLUMNS_SQL = `select n.nspname || '.' || c.relname as target, a.attname as name
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where a.attnum > 0 and not a.attisdropped
  and n.nspname || '.' || c.relname = any($1::text[])`;

const INDEX_COLUMNS_SQL = `select n.nspname || '.' || c.relname as target,
  array(
    select a.attname::text
    from unnest(i.indkey) with ordinality k(attnum, ord)
    left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum and k.attnum > 0
    where k.ord <= i.indnkeyatts
    order by k.ord
  ) as columns
from pg_index i
join pg_class c on c.oid = i.indrelid
join pg_namespace n on n.oid = c.relnamespace
where i.indpred is null and n.nspname || '.' || c.relname = any($1::text[])`;

function strings(value: unknown): readonly (string | null)[] {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === "string" ? item : null))
    : [];
}

/** Reads the columns and index key columns of `tables` (`schema.table`). */
export async function readTableIndexFacts(
  db: string,
  tables: readonly string[],
  connect: SqlConnect = (url) =>
    connectPgPool(url, "permdock rls generate --db"),
): Promise<TableIndexFacts> {
  const client = await connect(db);
  try {
    const [columns, indexes] = await Promise.all([
      client.query(COLUMNS_SQL, [[...tables]]),
      client.query(INDEX_COLUMNS_SQL, [[...tables]]),
    ]);
    const byTable: Record<string, string[]> = {};
    for (const row of columns.rows) {
      (byTable[String(row["target"])] ??= []).push(String(row["name"]));
    }
    const keys: Record<string, (readonly string[])[]> = {};
    for (const row of indexes.rows) {
      const list = strings(row["columns"]);
      const end = list.indexOf(null);
      // SAFETY: the slice ends before the first null, so every item is a string.
      const lead = (end === -1 ? list : list.slice(0, end)) as string[];
      if (lead.length > 0) {
        (keys[String(row["target"])] ??= []).push(lead);
      }
    }
    return { columns: byTable, indexes: keys };
  } finally {
    await client.end();
  }
}

/**
 * Drops the targets a database already serves or cannot hold: a target on a
 * table or column the database lacks (with a warning), and one an existing
 * index leads with (its key columns start with the target's).
 */
export function pruneIndexTargets(
  targets: readonly IndexTarget[],
  facts: TableIndexFacts,
): {
  readonly targets: readonly IndexTarget[];
  readonly warnings: readonly string[];
} {
  const warnings: string[] = [];
  const kept = targets.filter((target) => {
    const columns = facts.columns[target.table];
    if (columns === undefined) {
      warnings.push(
        `no index suggested on ${target.table}: the database has no such table`,
      );
      return false;
    }
    const absent = target.columns.filter((column) => !columns.includes(column));
    if (absent.length > 0) {
      warnings.push(
        `no index suggested on ${target.table} (${target.columns.join(", ")}): the table has no column ${absent.join(", ")}`,
      );
      return false;
    }
    return !(facts.indexes[target.table] ?? []).some((index) =>
      target.columns.every((column, at) => index[at] === column),
    );
  });
  return { targets: kept, warnings };
}
