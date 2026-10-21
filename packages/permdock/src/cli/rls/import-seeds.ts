import { parse } from "pgsql-parser";

import type { HelperScope, RolePermission } from "./helpers.ts";

import { asNode, asStmts, constValue, nodeStmt } from "./import-nodes.ts";

const SEED_COLUMNS = [
  "role",
  "permission",
  "grant_key",
  "scope",
  "effect",
] as const;

function asScope(value: unknown): HelperScope | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_]*$/u.test(value)
    ? value
    : undefined;
}

export function seedFromRow(
  row: Readonly<Record<string, unknown>>,
): RolePermission | undefined {
  const scope = asScope(row["scope"]);
  if (
    typeof row["role"] !== "string" ||
    typeof row["permission"] !== "string" ||
    typeof row["grant_key"] !== "string" ||
    scope === undefined
  ) {
    return undefined;
  }
  return {
    role: row["role"],
    permission: row["permission"],
    grantKey: row["grant_key"],
    scope,
    effect: row["effect"] === "deny" ? "deny" : "allow",
  };
}

/**
 * `role_permissions` rows from the `insert ... values` statements of a SQL
 * dump.
 */
export async function seedsFromSql(
  sql: string,
): Promise<readonly RolePermission[]> {
  let parsed: unknown;
  try {
    parsed = await parse(sql);
  } catch {
    return [];
  }
  const seeds: RolePermission[] = [];
  for (const item of asStmts(parsed)) {
    const insert = asNode(asNode(nodeStmt(asNode(item)))?.["InsertStmt"]);
    if (asNode(insert?.["relation"])?.["relname"] !== "role_permissions") {
      continue;
    }
    const cols = Array.isArray(insert?.["cols"])
      ? insert["cols"].map(
          (col) => asNode(asNode(col)?.["ResTarget"])?.["name"],
        )
      : [];
    const values = asNode(asNode(insert?.["selectStmt"])?.["SelectStmt"])?.[
      "valuesLists"
    ];
    if (!Array.isArray(values)) {
      continue;
    }
    for (const list of values) {
      const items = asNode(asNode(list)?.["List"])?.["items"];
      if (!Array.isArray(items)) {
        continue;
      }
      const row: Record<string, unknown> = {};
      for (const [index, col] of cols.entries()) {
        if (
          typeof col === "string" &&
          // SAFETY: widening the column union to string only lets includes() accept a parsed name.
          (SEED_COLUMNS as readonly string[]).includes(col)
        ) {
          row[col] = constValue(items[index]);
        }
      }
      const seed = seedFromRow(row);
      if (seed !== undefined) {
        seeds.push(seed);
      }
    }
  }
  return seeds;
}
