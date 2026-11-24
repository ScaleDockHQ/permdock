import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Policy } from "../../index.ts";
import type { PermDockConfig, RlsTable } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { scopeList } from "../../core/scopes.ts";
import { SqlSyntaxError, parseSqlFile } from "./ast.ts";

/** The folders whose `create table` statements define the app's tables. */
const SCHEMA_DIRS = ["supabase/schemas", "supabase/migrations"] as const;

/** Each table the schema files create, as `schema.table`, with its column types. */
export type SchemaTables = ReadonlyMap<string, ReadonlyMap<string, string>>;

function sqlFiles(dir: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.toSorted().flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "permdock" ? [] : sqlFiles(path);
    }
    return entry.endsWith(".sql") ? [path] : [];
  });
}

function svals(list: unknown): readonly string[] {
  return Array.isArray(list)
    ? list.flatMap((item: unknown) =>
        isRecord(item) &&
        isRecord(item["String"]) &&
        typeof item["String"]["sval"] === "string"
          ? [item["String"]["sval"]]
          : [],
      )
    : [];
}

function columnTypes(elements: unknown): Map<string, string> {
  const columns = new Map<string, string>();
  for (const element of Array.isArray(elements) ? elements : []) {
    const column: unknown = isRecord(element)
      ? element["ColumnDef"]
      : undefined;
    if (isRecord(column) && typeof column["colname"] === "string") {
      const type = isRecord(column["typeName"])
        ? svals(column["typeName"]["names"]).filter(
            (part) => part !== "pg_catalog",
          )
        : [];
      columns.set(column["colname"], type.join("."));
    }
  }
  return columns;
}

/**
 * The tables `supabase/schemas` and `supabase/migrations` create, read from the
 * parsed `CreateStmt` nodes. A file the parser rejects is skipped; the
 * generated files under `permdock/` are not read.
 */
export async function schemaTables(cwd: string): Promise<SchemaTables> {
  const tables = new Map<string, Map<string, string>>();
  for (const dir of SCHEMA_DIRS) {
    for (const file of sqlFiles(join(cwd, dir))) {
      let nodes: Awaited<ReturnType<typeof parseSqlFile>>;
      try {
        nodes = await parseSqlFile(readFileSync(file, "utf8"));
      } catch (error) {
        if (error instanceof SqlSyntaxError) {
          continue;
        }
        throw error;
      }
      for (const node of nodes) {
        const relation = node.node["relation"];
        if (node.kind !== "CreateStmt" || !isRecord(relation)) {
          continue;
        }
        const schema =
          typeof relation["schemaname"] === "string"
            ? relation["schemaname"]
            : "public";
        const name = `${schema}.${String(relation["relname"])}`;
        const columns = columnTypes(node.node["tableElts"]);
        tables.set(name, columns);
      }
    }
  }
  return tables;
}

/** `teamMember` to `team_members`, `category` to `categories`. */
export function pluralTableName(resource: string): string {
  const snake = resource
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();
  if (/[^aeiou]y$/u.test(snake)) {
    return `${snake.slice(0, -1)}ies`;
  }
  if (/(s|x|z|ch|sh)$/u.test(snake)) {
    return `${snake}es`;
  }
  return `${snake}s`;
}

function qualified(table: string): string {
  return table.includes(".") ? table : `public.${table}`;
}

/** The internal type names Postgres reports, as the names a config writes. */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  int4: "integer",
  int8: "bigint",
  int2: "smallint",
  varchar: "text",
  bpchar: "text",
};

export type SchemaDefaults = {
  /** Resources mapped to their snake_case plural table. */
  readonly tables: Readonly<Record<string, string>>;
  /** Scope id types read from the scope table's `id` column. */
  readonly scopeTypes: Readonly<Record<string, string>>;
  /** Resources with no entry whose table neither name finds. */
  readonly unknown: readonly {
    readonly resource: string;
    readonly tried: readonly string[];
  }[];
};

function tableEntryName(entry: RlsTable | undefined): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }
  return typeof entry === "object" && "table" in entry
    ? entry.table
    : undefined;
}

/**
 * The `rls.tables` and `rls.scopeTypes` entries the schema files imply. A
 * resource with no entry maps to its snake_case plural when that table exists
 * and the verbatim name does not; a scope with no `scopeTypes` entry takes the
 * type of its table's `id` column.
 */
export function schemaDefaults(
  config: PermDockConfig,
  policy: Policy,
  tables: SchemaTables,
): SchemaDefaults {
  const written = config.rls?.tables ?? {};
  const mapped: Record<string, string> = {};
  const unknown: { resource: string; tried: readonly string[] }[] = [];
  for (const resource of [...policy.resources.keys()].toSorted()) {
    if (Object.hasOwn(written, resource)) {
      continue;
    }
    const plural = pluralTableName(resource);
    if (tables.has(qualified(resource))) {
      continue;
    }
    if (tables.has(qualified(plural))) {
      mapped[resource] = plural;
      continue;
    }
    unknown.push({ resource, tried: [resource, plural] });
  }
  const scopeTypes: Record<string, string> = {};
  for (const scope of scopeList(policy.scopes)) {
    if (config.rls?.scopeTypes?.[scope.name] !== undefined) {
      continue;
    }
    const table =
      tableEntryName(written[scope.name]) ??
      mapped[scope.name] ??
      (tables.has(qualified(pluralTableName(scope.name)))
        ? pluralTableName(scope.name)
        : scope.name);
    const type = tables.get(qualified(table))?.get("id");
    if (type !== undefined && type !== "") {
      scopeTypes[scope.name] = TYPE_NAMES[type] ?? type;
    }
  }
  return { tables: mapped, scopeTypes, unknown };
}

/** `config` with the `rls.tables` and `rls.scopeTypes` the schema files imply. */
export async function withSchemaDefaults(
  cwd: string,
  config: PermDockConfig,
  policy: Policy,
): Promise<PermDockConfig> {
  const rls = config.rls;
  if (rls === undefined) {
    return config;
  }
  const tables = await schemaTables(cwd);
  if (tables.size === 0) {
    return config;
  }
  const defaults = schemaDefaults(config, policy, tables);
  const addTables = Object.keys(defaults.tables).length > 0;
  const addTypes = Object.keys(defaults.scopeTypes).length > 0;
  if (!addTables && !addTypes) {
    return config;
  }
  return {
    ...config,
    rls: {
      ...rls,
      ...(addTables ? { tables: { ...defaults.tables, ...rls.tables } } : {}),
      ...(addTypes
        ? { scopeTypes: { ...defaults.scopeTypes, ...rls.scopeTypes } }
        : {}),
    },
  };
}
