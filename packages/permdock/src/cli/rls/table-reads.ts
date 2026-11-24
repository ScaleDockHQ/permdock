import { readFileSync } from "node:fs";

import type {
  SupabaseManifest,
  SupabaseManifestTableRead,
} from "../../supabase/manifest.ts";
import type { SqlPolicy } from "../sql/ast.ts";
import type { PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import {
  SqlSyntaxError,
  parseSqlFile,
  readPolicy,
  sqlCalls,
} from "../sql/ast.ts";
import { taggedAccessPolicies } from "../sql/bsb-access.ts";
import { isPlatformSchema } from "../sql/platform.ts";
import { tenantCheck } from "../sql/tenant-check.ts";
import { droppedPolicy, reportFiles } from "./report.ts";

type TableRead = SupabaseManifestTableRead;

/** better-supabase's own tables, which its block SQL owns. */
const LIBRARY_SCHEMAS: ReadonlySet<string> = new Set(["better_supabase"]);

type TableReadRule = NonNullable<TableRead["rules"]>[number];

type ReadPolicy = Pick<
  SqlPolicy,
  "name" | "command" | "permissive" | "roles" | "using"
> & {
  /** A policy an `@bsb access` tag renders: the tenant form by construction. */
  readonly tagged?: { readonly column: string; readonly key: string };
};

type TableFacts = { rls: boolean; readonly policies: Map<string, ReadPolicy> };

function relationName(relation: unknown): string | undefined {
  if (!isRecord(relation) || typeof relation["relname"] !== "string") {
    return undefined;
  }
  const schema =
    typeof relation["schemaname"] === "string"
      ? relation["schemaname"]
      : "public";
  return `${schema}.${relation["relname"]}`.toLowerCase();
}

function enablesRls(node: Readonly<Record<string, unknown>>): boolean {
  const cmds = Array.isArray(node["cmds"]) ? node["cmds"] : [];
  return cmds.some((cmd: unknown) => {
    const alter: unknown = isRecord(cmd) ? cmd["AlterTableCmd"] : undefined;
    return isRecord(alter) && alter["subtype"] === "AT_EnableRowSecurity";
  });
}

function readsColumn(expr: unknown): boolean {
  if (Array.isArray(expr)) {
    return expr.some((item) => readsColumn(item));
  }
  if (!isRecord(expr)) {
    return false;
  }
  return Object.entries(expr).some(
    ([key, child]) => key === "ColumnRef" || readsColumn(child),
  );
}

function appliesToSelect(policy: ReadPolicy): boolean {
  return (
    (policy.command === "select" || policy.command === "all") &&
    policy.roles.some((role) => role === "authenticated" || role === "public")
  );
}

/** The rule a permissive select policy that is not the tenant form breaks. */
function ruleOf(policy: ReadPolicy, plainHelper: string): TableReadRule {
  const names = sqlCalls(policy.using).map((call) => call.name.join("."));
  if (names.length > 0 && names.every((name) => name === plainHelper)) {
    return "form";
  }
  if (names.some((name) => name.includes("follows"))) {
    return "follows";
  }
  if (names.some((name) => name.includes("_via"))) {
    return "via";
  }
  if (names.some((name) => name.includes("walk"))) {
    return "walk";
  }
  if (
    names.some(
      (name) => name === "auth.uid" || name.endsWith("permdock_user_id"),
    )
  ) {
    return "owner";
  }
  return policy.using === undefined ? "unknown" : "condition";
}

function keysOf(expr: unknown, helper: string): readonly string[] {
  return sqlCalls(expr).flatMap((call) => {
    if (call.name.join(".") !== helper) {
      return [];
    }
    const args = Array.isArray(call.node["args"]) ? call.node["args"] : [];
    const constant: unknown =
      args.length === 1 && isRecord(args[0]) ? args[0]["A_Const"] : undefined;
    const value: unknown =
      isRecord(constant) && isRecord(constant["sval"])
        ? constant["sval"]["sval"]
        : undefined;
    return typeof value === "string" ? [value] : [];
  });
}

function readOf(
  table: string,
  facts: TableFacts | undefined,
  helpers: { readonly plain: string; readonly byPermission: string },
  fieldTables: ReadonlySet<string>,
): TableRead {
  if (facts === undefined || !facts.rls) {
    return { table, share: "row", rules: ["unknown"] };
  }
  const selects = [...facts.policies.values()].filter(appliesToSelect);
  const permissive = selects.filter((policy) => policy.permissive);
  const rules = new Set<TableReadRule>();
  const columns = new Set<string>();
  const keys = new Set<string>();
  if (fieldTables.has(table)) {
    rules.add("fields");
  }
  if (permissive.length === 0) {
    rules.add("unknown");
  }
  for (const policy of permissive) {
    const check =
      policy.tagged ?? tenantCheck(policy.using, helpers.byPermission);
    for (const key of policy.tagged === undefined
      ? keysOf(policy.using, helpers.byPermission)
      : [policy.tagged.key]) {
      keys.add(key);
    }
    if (check === undefined) {
      rules.add(ruleOf(policy, helpers.plain));
    } else {
      columns.add(check.column);
    }
  }
  if (
    selects.some((policy) => !policy.permissive && readsColumn(policy.using))
  ) {
    rules.add("restrictive");
  }
  if (rules.size === 0 && columns.size > 1) {
    rules.add("condition");
  }
  const permissions = [...keys].toSorted();
  const listed = permissions.length === 0 ? {} : { permissions };
  if (rules.size > 0) {
    return { table, share: "row", ...listed, rules: [...rules].toSorted() };
  }
  const [column] = columns;
  return {
    table,
    share: "tenant",
    ...(column === undefined ? {} : { column }),
    ...listed,
  };
}

/**
 * `rls.tableReads`: for each table the schema files and migrations create, from
 * the select policies they leave defined plus the policies `@bsb access` tags
 * render. A table is `tenant` only when row level security is on, it has no
 * field view, every permissive select policy for `authenticated` is `<column>
 * in (select <schema>.permitted_<root>_ids_by_permission('<key>'))` on one
 * column, and every restrictive select policy reads no column of the row.
 * Everything else is `row`, with the rules it breaks. Tables in the helpers'
 * schema, `better_supabase` and platform schemas are left out. A file
 * libpg_query rejects is skipped. The files are read from disk, so select
 * policies a `generate` run changes in `rls.out` are recorded on the next run.
 */
export async function tableReads(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  /** The helpers' schema. */
  readonly schema: string;
  /** The root scope's name. */
  readonly root: string;
  /** The qualified tables that have a field view, lower case. */
  readonly fieldTables?: ReadonlySet<string>;
}): Promise<readonly TableRead[]> {
  const created = new Set<string>();
  const facts = new Map<string, TableFacts>();
  const factsOf = (table: string): TableFacts => {
    const found = facts.get(table) ?? { rls: false, policies: new Map() };
    facts.set(table, found);
    return found;
  };
  for (const file of reportFiles(input.cwd, input.config)) {
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
      if (node.kind === "CreateStmt") {
        const table = relationName(node.node["relation"]);
        if (table !== undefined) {
          created.add(table);
        }
      } else if (node.kind === "AlterTableStmt" && enablesRls(node.node)) {
        const table = relationName(node.node["relation"]);
        if (table !== undefined) {
          factsOf(table).rls = true;
        }
      } else if (node.kind === "DropStmt") {
        const dropped = droppedPolicy(node.node);
        if (dropped !== undefined) {
          facts
            .get(`${dropped.schema}.${dropped.table}`.toLowerCase())
            ?.policies.delete(dropped.name);
        }
      } else {
        const policy = readPolicy(node);
        if (policy !== undefined) {
          factsOf(
            `${policy.schema}.${policy.table}`.toLowerCase(),
          ).policies.set(policy.name, policy);
        }
      }
    }
  }
  for (const tagged of await taggedAccessPolicies(input.cwd)) {
    if (tagged.operation.toLowerCase() !== "read") {
      continue;
    }
    factsOf(`${tagged.schema}.${tagged.table}`.toLowerCase()).policies.set(
      tagged.name,
      {
        name: tagged.name,
        command: "select",
        permissive: true,
        roles: ["authenticated"],
        tagged: { column: tagged.tenantColumn, key: tagged.key },
      },
    );
  }
  const helpers = {
    plain: `${input.schema}.permitted_${input.root}_ids`,
    byPermission: `${input.schema}.permitted_${input.root}_ids_by_permission`,
  };
  const helperSchema = input.schema.toLowerCase();
  return [...created]
    .filter((table) => {
      const schema = table.slice(0, table.indexOf("."));
      return (
        schema !== helperSchema &&
        !LIBRARY_SCHEMAS.has(schema) &&
        !isPlatformSchema(schema)
      );
    })
    .toSorted()
    .map((table) =>
      readOf(table, facts.get(table), helpers, input.fieldTables ?? new Set()),
    );
}

/** `tableReads` for the helpers, root scope and field views `manifest` names. */
export function manifestTableReads(
  cwd: string,
  config: PermDockConfig,
  manifest: SupabaseManifest,
): Promise<readonly TableRead[]> {
  const root = manifest.rls.scopes[0]?.name;
  if (root === undefined) {
    return Promise.resolve([]);
  }
  const fieldTables = new Set(
    Object.values(manifest.names?.resources ?? {}).flatMap((names) =>
      names.table === undefined || names.visible === undefined
        ? []
        : [
            (names.table.includes(".")
              ? names.table
              : `public.${names.table}`
            ).toLowerCase(),
          ],
    ),
  );
  return tableReads({
    cwd,
    config,
    schema: manifest.rls.schema,
    root,
    fieldTables,
  });
}

/**
 * `manifest` with `rls.tableReads` from the files on disk; unchanged when the
 * files create no table.
 */
export async function withTableReads<M extends SupabaseManifest>(
  cwd: string,
  config: PermDockConfig,
  manifest: M,
): Promise<M> {
  const reads = await manifestTableReads(cwd, config, manifest);
  return reads.length === 0
    ? manifest
    : { ...manifest, rls: { ...manifest.rls, tableReads: reads } };
}
