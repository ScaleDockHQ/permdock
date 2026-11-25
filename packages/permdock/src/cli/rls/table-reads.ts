import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import type {
  SupabaseManifest,
  SupabaseManifestTableRead,
} from "../../supabase/manifest.ts";
import type { PermDockConfig } from "../types.ts";
import type { KeyReasons } from "./key-reasons.ts";
import type { ReadPolicy } from "./table-reasons.ts";

import { isRecord } from "../../core/compact.ts";
import { scopeList } from "../../core/scopes.ts";
import { parseSupabaseManifest } from "../../supabase/manifest.ts";
import { readJsonFile } from "../files.ts";
import { MANIFEST_FILE } from "../manifest-json.ts";
import { loadConfiguredPolicy } from "../project/load.ts";
import {
  SqlSyntaxError,
  parseSqlFile,
  readPolicy,
  sqlCalls,
  stringValues,
} from "../sql/ast.ts";
import { taggedAccessPolicies } from "../sql/bsb-access.ts";
import { isPlatformSchema } from "../sql/platform.ts";
import { tenantCheck } from "../sql/tenant-check.ts";
import { keyReason, tryKeyReasons } from "./key-reasons.ts";
import { droppedPolicy, reportFiles } from "./report.ts";
import { sharedFunctionsOf, tenantPureHelpersOf } from "./shared-functions.ts";
import {
  formBlockers,
  restrictiveReason,
  ruleReason,
  unknownReason,
} from "./table-reasons.ts";

type TableRead = SupabaseManifestTableRead;

/** better-supabase's own tables, which its block SQL owns. */
const LIBRARY_SCHEMAS: ReadonlySet<string> = new Set(["better_supabase"]);

type TableReadRule = NonNullable<TableRead["rules"]>[number];

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

/** The qualified tables a `drop table` statement removes, lower case. */
function droppedTables(node: Readonly<Record<string, unknown>>): string[] {
  const objects = node["objects"];
  if (node["removeType"] !== "OBJECT_TABLE" || !Array.isArray(objects)) {
    return [];
  }
  return objects.flatMap((object: unknown) => {
    const list: unknown = isRecord(object) ? object["List"] : undefined;
    const items: unknown = isRecord(list) ? list["items"] : undefined;
    const parts = stringValues(items);
    const name = parts.at(-1);
    return name === undefined
      ? []
      : [`${parts.length > 1 ? parts.at(-2) : "public"}.${name}`.toLowerCase()];
  });
}

/** `alter table <from> rename to <to>`: the two qualified names, lower case. */
function renamedTable(
  node: Readonly<Record<string, unknown>>,
): { readonly from: string; readonly to: string } | undefined {
  const from = relationName(node["relation"]);
  const name = node["newname"];
  if (
    node["renameType"] !== "OBJECT_TABLE" ||
    from === undefined ||
    typeof name !== "string"
  ) {
    return undefined;
  }
  return {
    from,
    to: `${from.slice(0, from.indexOf("."))}.${name.toLowerCase()}`,
  };
}

function renameTable(
  created: Set<string>,
  facts: Map<string, TableFacts>,
  renamed: { readonly from: string; readonly to: string } | undefined,
): void {
  if (renamed === undefined) {
    return;
  }
  created.delete(renamed.from);
  created.add(renamed.to);
  const moved = facts.get(renamed.from);
  facts.delete(renamed.from);
  if (moved !== undefined) {
    facts.set(renamed.to, moved);
  }
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

/**
 * The tenant checks a permissive policy ORs in: the expression itself or an
 * argument of its top-level `or`. Other disjuncts only add rows.
 */
function tenantDisjuncts(
  expr: unknown,
  helper: string,
): readonly { readonly column: string; readonly key: string }[] {
  const bool: unknown = isRecord(expr) ? expr["BoolExpr"] : undefined;
  const args: unknown[] =
    isRecord(bool) &&
    bool["boolop"] === "OR_EXPR" &&
    Array.isArray(bool["args"])
      ? bool["args"]
      : [expr];
  return args.flatMap((arg) => {
    const check = tenantCheck(arg, helper);
    return check === undefined ? [] : [check];
  });
}

function keysOf(expr: unknown, helper: string): readonly string[] {
  return sqlCalls(expr).flatMap((call) => {
    if (call.name.join(".") !== helper) {
      return [];
    }
    const args = Array.isArray(call.node["args"]) ? call.node["args"] : [];
    const [first] = args;
    // A dump writes the key as 'x'::text, a TypeCast around the constant.
    const cast: unknown = isRecord(first) ? first["TypeCast"] : undefined;
    const inner: unknown =
      isRecord(cast) && isRecord(cast["arg"]) ? cast["arg"] : first;
    const constant: unknown =
      args.length === 1 && isRecord(inner) ? inner["A_Const"] : undefined;
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
  reasons: KeyReasons | undefined,
): TableRead {
  if (facts === undefined || !facts.rls) {
    return {
      table,
      share: "row",
      rules: ["unknown"],
      reason: unknownReason(
        facts === undefined ? "no-facts" : "no-rls",
        facts === undefined ? [] : [...facts.policies.values()],
      ),
    };
  }
  const all = [...facts.policies.values()];
  const selects = all.filter(appliesToSelect);
  const permissive = selects.filter((policy) => policy.permissive);
  const rules = new Set<TableReadRule>();
  const columns = new Map<string, string>();
  const keys = new Set<string>();
  const formKeys = new Set<string>();
  const formPolicies: ReadPolicy[] = [];
  const parts: string[] = [];
  const widenKeys = new Set<string>();
  const widenColumns = new Set<string>();
  const stale: ReadPolicy[] = [];
  const hasTag = all.some((p) => p.tagged !== undefined);
  if (fieldTables.has(table)) {
    rules.add("fields");
    parts.push("the table has a field view, which reads rows per field grant");
  }
  if (permissive.length === 0) {
    rules.add("unknown");
    parts.push(unknownReason("no-select", all));
  }
  for (const policy of permissive) {
    const check =
      policy.tagged ?? tenantCheck(policy.using, helpers.byPermission);
    for (const key of policy.tagged === undefined
      ? keysOf(policy.using, helpers.byPermission)
      : [policy.tagged.key]) {
      keys.add(key);
    }
    for (const found of policy.tagged === undefined
      ? tenantDisjuncts(policy.using, helpers.byPermission)
      : [policy.tagged]) {
      widenKeys.add(found.key);
      widenColumns.add(found.column);
    }
    if (check === undefined) {
      const rule = ruleOf(policy, helpers.plain);
      rules.add(rule);
      if (rule === "form") {
        formPolicies.push(policy);
        if (hasTag) {
          stale.push(policy);
        }
        for (const key of keysOf(policy.using, helpers.plain)) {
          formKeys.add(key);
        }
      } else {
        parts.push(ruleReason(rule, policy, helpers));
      }
    } else if (!columns.has(check.column)) {
      columns.set(check.column, policy.name);
    }
  }
  for (const policy of selects) {
    if (!policy.permissive && readsColumn(policy.using)) {
      rules.add("restrictive");
      parts.push(restrictiveReason(policy));
    }
  }
  if (rules.size === 0 && columns.size > 1) {
    rules.add("condition");
    parts.push(
      `tenant checks on ${columns.size} columns: ${[...columns].map(([column, name]) => `${name} on ${column}`).join(", ")}`,
    );
  }
  const permissions = [...keys].toSorted();
  const listed = permissions.length === 0 ? {} : { permissions };
  if (rules.size > 0) {
    for (const policy of formPolicies) {
      const blockers = stale.includes(policy)
        ? [
            `policy ${policy.name} is still defined${policy.file === undefined ? "" : ` in ${policy.file}`} next to an @bsb access tag that renders the table's policy: write a migration that drops it`,
          ]
        : formBlockers(policy, all, helpers);
      parts.push(...blockers);
      if (
        blockers.length === 0 &&
        reasons !== undefined &&
        keysOf(policy.using, helpers.plain).every((key) =>
          reasons.swappable.has(key),
        )
      ) {
        parts.push(
          `policy ${policy.name} is movable: nothing on the table blocks permdock codemod bsb-access-tags`,
        );
      }
    }
    if (reasons !== undefined && stale.length === 0) {
      parts.push(
        ...[...formKeys]
          .toSorted()
          .map((key) => `key ${key}: ${keyReason(reasons, key)}`),
      );
    }
    const why = parts.length === 0 ? undefined : parts.join("; ");
    const [widened] = widenColumns;
    const holds =
      widenColumns.size === 1 &&
      widened !== undefined &&
      widenKeys.size > 0 &&
      !rules.has("restrictive") &&
      !rules.has("fields") &&
      !rules.has("unknown");
    return {
      table,
      share: "row",
      ...(holds ? { column: widened } : {}),
      ...listed,
      rules: [...rules].toSorted(),
      ...(holds ? { tenantFor: [...widenKeys].toSorted() } : {}),
      ...(why === undefined ? {} : { reason: why }),
    };
  }
  const [column] = columns.keys();
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
  /**
   * Why a key's by-permission helper differs from the plain one, for a `form`
   * table.
   */
  readonly reasons?: KeyReasons;
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
        for (const table of droppedTables(node.node)) {
          created.delete(table);
          facts.delete(table);
        }
      } else if (node.kind === "RenameStmt") {
        renameTable(created, facts, renamedTable(node.node));
      } else {
        const policy = readPolicy(node);
        if (policy !== undefined) {
          factsOf(
            `${policy.schema}.${policy.table}`.toLowerCase(),
          ).policies.set(policy.name, {
            ...policy,
            file: relative(input.cwd, file),
          });
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
      readOf(
        table,
        facts.get(table),
        helpers,
        input.fieldTables ?? new Set(),
        input.reasons,
      ),
    );
}

/** `tableReads` for the helpers, root scope and field views `manifest` names. */
export function manifestTableReads(
  cwd: string,
  config: PermDockConfig,
  manifest: SupabaseManifest,
  reasons?: KeyReasons,
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
    ...(reasons === undefined ? {} : { reasons }),
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
  reasons?: KeyReasons,
): Promise<M> {
  const reads = await manifestTableReads(cwd, config, manifest, reasons);
  const tenantPureHelpers = tenantPureHelpersOf(manifest);
  const pure = tenantPureHelpers.length === 0 ? {} : { tenantPureHelpers };
  if (reads.length === 0) {
    return { ...manifest, rls: { ...manifest.rls, ...pure } };
  }
  const sharedFunctions = await sharedFunctionsOf({
    cwd,
    config,
    schema: manifest.rls.schema,
    tableReads: reads,
  });
  return {
    ...manifest,
    rls: { ...manifest.rls, tableReads: reads, sharedFunctions, ...pure },
  };
}

/**
 * The committed `permdock.manifest.json`, or `undefined` when it is absent or
 * unreadable.
 */
export function committedManifest(cwd: string): SupabaseManifest | undefined {
  const path = join(cwd, MANIFEST_FILE);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return parseSupabaseManifest(readJsonFile(path));
  } catch {
    return undefined;
  }
}

/**
 * `tableReads` for the configured policy, with the reason of each `form` table.
 * Field views come from the committed manifest when there is one. Without a
 * policy the answer is empty; a policy the generator refuses leaves out the
 * reasons only.
 */
export async function configuredTableReads(
  cwd: string,
  config: PermDockConfig,
): Promise<readonly TableRead[]> {
  const policy = await loadConfiguredPolicy(cwd, config.policy);
  const root =
    policy === undefined ? undefined : scopeList(policy.scopes)[0]?.name;
  if (policy === undefined || root === undefined) {
    return [];
  }
  const reasons = tryKeyReasons(config, policy, cwd);
  const manifest = committedManifest(cwd);
  if (manifest !== undefined) {
    return manifestTableReads(cwd, config, manifest, reasons);
  }
  return tableReads({
    cwd,
    config,
    schema: config.rls?.schema ?? "permdock",
    root,
    ...(reasons === undefined ? {} : { reasons }),
  });
}
