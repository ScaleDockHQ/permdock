import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";

import type { SqlNode, SqlRelation } from "../sql/ast.ts";
import type { IndexTarget } from "./indexes.ts";

import { isRecord } from "../../core/compact.ts";
import { sqlFiles } from "../files.ts";
import { MIGRATION_DIRS } from "../shared/constants.ts";
import { parseSqlLenient, readRelation, stringValues } from "../sql/ast.ts";

/**
 * An index PermDock generated (`permdock_<table>_<columns>_idx`), in the
 * indexes part or in a migration derived from it: it never counts as serving
 * its own target.
 */
const GENERATED_INDEX = /^permdock_\w*_idx$/u;

const KEY_CONSTRAINTS: ReadonlySet<string> = new Set([
  "CONSTR_PRIMARY",
  "CONSTR_UNIQUE",
]);

/** `schema.table`, with `public` for an unqualified name. */
function qualified(relation: SqlRelation): string {
  return `${relation.schema ?? "public"}.${relation.name}`;
}

/** The plain key columns of an index column list, cut at the first expression. */
function indexColumns(params: unknown): string[] {
  const columns: string[] = [];
  for (const item of Array.isArray(params) ? params : []) {
    const element: unknown = isRecord(item) ? item["IndexElem"] : undefined;
    if (!isRecord(element) || typeof element["name"] !== "string") {
      break;
    }
    columns.push(element["name"]);
  }
  return columns;
}

/** The key columns of a `primary key` or `unique` constraint node. */
function constraintKeys(value: unknown): string[] | undefined {
  const constraint: unknown = isRecord(value) ? value["Constraint"] : undefined;
  if (
    !isRecord(constraint) ||
    !KEY_CONSTRAINTS.has(String(constraint["contype"]))
  ) {
    return undefined;
  }
  return [...stringValues(constraint["keys"])];
}

/** The `[table, columns]` keys one statement creates. */
function statementKeys(
  statement: SqlNode,
): readonly (readonly [string, string[]])[] {
  const { node } = statement;
  const relation = readRelation(node["relation"]);
  if (relation === undefined) {
    return [];
  }
  const table = qualified(relation);
  switch (statement.kind) {
    case "IndexStmt": {
      const name = node["idxname"];
      return typeof name === "string" && GENERATED_INDEX.test(name)
        ? []
        : [[table, indexColumns(node["indexParams"])]];
    }
    case "AlterTableStmt": {
      const commands = Array.isArray(node["cmds"]) ? node["cmds"] : [];
      return commands.flatMap((item: unknown) => {
        const command: unknown = isRecord(item)
          ? item["AlterTableCmd"]
          : undefined;
        const keys =
          isRecord(command) && command["subtype"] === "AT_AddConstraint"
            ? constraintKeys(command["def"])
            : undefined;
        return keys === undefined ? [] : [[table, keys] as const];
      });
    }
    case "CreateStmt": {
      const elements = Array.isArray(node["tableElts"])
        ? node["tableElts"]
        : [];
      return elements.flatMap((item: unknown) => {
        const tableKeys = constraintKeys(item);
        if (tableKeys !== undefined) {
          return [[table, tableKeys] as const];
        }
        const column: unknown = isRecord(item) ? item["ColumnDef"] : undefined;
        if (!isRecord(column) || typeof column["colname"] !== "string") {
          return [];
        }
        const name = column["colname"];
        const constraints = Array.isArray(column["constraints"])
          ? column["constraints"]
          : [];
        return constraints.some(
          (constraint: unknown) => constraintKeys(constraint) !== undefined,
        )
          ? [[table, [name]] as const]
          : [];
      });
    }
    default:
      return [];
  }
}

/**
 * Key columns of each index, unique constraint and primary key the SQL creates,
 * per `schema.table`. Indexes PermDock generated are left out.
 */
export async function indexKeysFromSql(
  sql: string,
): Promise<Readonly<Record<string, readonly (readonly string[])[]>>> {
  const keys: Record<string, string[][]> = {};
  for (const statement of await parseSqlLenient(sql)) {
    for (const [table, columns] of statementKeys(statement)) {
      if (columns.length > 0) {
        (keys[table] ??= []).push(columns);
      }
    }
  }
  return keys;
}

/**
 * The SQL files under the migration and schema folders of `cwd`, without the
 * `permdock` folders: other `generate` plugins write those during the same run,
 * so reading them would make the result depend on plugin order.
 */
function appSqlFiles(cwd: string): readonly string[] {
  return sqlFiles(cwd, [...MIGRATION_DIRS]).filter(
    (file) => !relative(cwd, file).split(sep).includes("permdock"),
  );
}

/**
 * The index keys of the SQL files under the migration and schema folders of
 * `cwd`.
 */
export async function indexKeysFromProject(
  cwd: string,
): Promise<Readonly<Record<string, readonly (readonly string[])[]>>> {
  const all: Record<string, (readonly string[])[]> = {};
  for (const file of appSqlFiles(cwd)) {
    const keys = await indexKeysFromSql(readFileSync(file, "utf8"));
    for (const [table, list] of Object.entries(keys)) {
      (all[table] ??= []).push(...list);
    }
  }
  return all;
}

/** Every `schema.table` the SQL creates, temporary tables left out. */
export async function tablesFromSql(sql: string): Promise<ReadonlySet<string>> {
  const tables = new Set<string>();
  for (const statement of await parseSqlLenient(sql)) {
    const into: unknown = statement.node["into"];
    const relation =
      statement.kind === "CreateStmt"
        ? readRelation(statement.node["relation"])
        : statement.kind === "CreateTableAsStmt" && isRecord(into)
          ? readRelation(into["rel"])
          : undefined;
    if (relation !== undefined && relation.persistence !== "t") {
      tables.add(qualified(relation));
    }
  }
  return tables;
}

/**
 * Every `schema.table` the SQL files under the migration and schema folders of
 * `cwd` create.
 */
export async function tablesFromProject(
  cwd: string,
): Promise<ReadonlySet<string>> {
  const all = new Set<string>();
  for (const file of appSqlFiles(cwd)) {
    for (const table of await tablesFromSql(readFileSync(file, "utf8"))) {
      all.add(table);
    }
  }
  return all;
}

/**
 * The targets no index in `keys` leads with: its key columns start with the
 * target's, as `pruneIndexTargets` reads a database.
 */
export function withoutServedTargets(
  targets: readonly IndexTarget[],
  keys: Readonly<Record<string, readonly (readonly string[])[]>>,
): readonly IndexTarget[] {
  return targets.filter(
    (target) =>
      !(keys[target.table] ?? []).some((key) =>
        target.columns.every((column, at) => key[at] === column),
      ),
  );
}
