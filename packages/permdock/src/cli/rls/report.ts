import { readFileSync } from "node:fs";
import { deparse } from "pgsql-parser";

import type { SupabaseManifestTableRead } from "../../supabase/manifest.ts";
import type { CommandResult } from "../core/result.ts";
import type { SqlConnect } from "../pg.ts";
import type { SqlPolicy } from "../sql/ast.ts";
import type { PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { outFiles } from "../core/output-files.ts";
import { rel, sqlFiles } from "../files.ts";
import { MIGRATION_DIRS } from "../shared/constants.ts";
import {
  SqlSyntaxError,
  isPolicyCommand,
  parseSqlFile,
  readPolicy,
  sqlCalls,
} from "../sql/ast.ts";
import { taggedAccessPolicies } from "../sql/bsb-access.ts";
import { callsHelper, helperCallKeys } from "../sql/helper-calls.ts";
import { isStripeDataPipelineSchema } from "../sql/platform.ts";
import { supabaseDir } from "../supabase-dir.ts";

/** Who owns a policy, in better-supabase BS641's words. */
export type PolicyOrigin = "library" | "provider" | "app";

/** One policy of `permdock rls report`. */
export type ReportedPolicy = {
  readonly name: string;
  /** The commands it applies to; `for all` lists the four. */
  readonly commands: readonly ReportCommand[];
  readonly roles: readonly string[];
  readonly permissive: boolean;
  readonly origin: PolicyOrigin;
  /** The PermDock helpers it calls, each once, in source order. */
  readonly helpers: readonly string[];
  /** Helper calls in its `using` and `with check`, repeats counted. */
  readonly helperCalls: number;
  /** The permission keys it passes to the helpers. */
  readonly keys: readonly string[];
  /** Where it is defined; unset for `pg_policies` and `@bsb access` tags. */
  readonly file?: string;
  readonly line?: number;
};

export type ReportCommand = "select" | "insert" | "update" | "delete";

/** One table of `permdock rls report`. */
export type ReportedTable = {
  /** `schema.table`. */
  readonly table: string;
  readonly policies: readonly ReportedPolicy[];
  /**
   * Per command, the helper calls Postgres runs for an `authenticated` row:
   * every policy for the command and role summed.
   */
  readonly helperCallsPerStatement: Readonly<Record<ReportCommand, number>>;
  /**
   * Indexed columns whose `=` is not leakproof, so a filter on them never uses
   * the index under RLS; read from the database only.
   */
  readonly nonLeakproofIndexed?: readonly {
    readonly column: string;
    readonly type: string;
  }[];
};

/** The rules a `row` table can break, in the order the report lists them. */
export const TABLE_READ_RULES = [
  "form",
  "follows",
  "via",
  "walk",
  "owner",
  "condition",
  "restrictive",
  "fields",
  "unknown",
] as const;

export type TableReadRuleName = (typeof TABLE_READ_RULES)[number];

/** `rls.tableReads` counted: a table that breaks two rules counts under both. */
export type TableReadsReport = {
  readonly tenant: number;
  readonly row: number;
  readonly byRule: Readonly<Record<TableReadRuleName, number>>;
  readonly tables: readonly SupabaseManifestTableRead[];
};

/** The counts of `reads` per share and per rule. */
export function summariseTableReads(
  reads: readonly SupabaseManifestTableRead[],
): TableReadsReport {
  // SAFETY: one entry per name in TABLE_READ_RULES.
  const byRule = Object.fromEntries(
    TABLE_READ_RULES.map((rule) => [
      rule,
      reads.filter((read) => read.rules?.includes(rule) === true).length,
    ]),
  ) as Record<TableReadRuleName, number>;
  return {
    tenant: reads.filter((read) => read.share === "tenant").length,
    row: reads.filter((read) => read.share === "row").length,
    byRule,
    tables: reads,
  };
}

/** What `permdock rls report --json` prints as `data`. */
export type RlsReport = {
  /** `files` for the schema files and migrations, `database` for `pg_policies`. */
  readonly source: "files" | "database";
  readonly tables: readonly ReportedTable[];
  readonly totals: Readonly<Record<PolicyOrigin, number>> & {
    readonly policies: number;
  };
  /** Absent without a configured policy. */
  readonly tableReads?: TableReadsReport;
};

const COMMANDS: readonly ReportCommand[] = [
  "select",
  "insert",
  "update",
  "delete",
];

/** The default of `doctor.policies.max`, better-supabase BS641's too. */
export const POLICIES_MAX = 4;

type RawPolicy = {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly command: SqlPolicy["command"];
  readonly roles: readonly string[];
  readonly permissive: boolean;
  readonly calls: readonly (readonly string[])[];
  readonly body: string;
  readonly tagged: boolean;
  readonly file?: string;
  readonly line?: number;
};

/** better-supabase's own functions share the `member_<scope>_ids` names. */
const LIBRARY_SCHEMAS: ReadonlySet<string> = new Set(["better_supabase"]);

function isProviderCall(name: readonly string[]): boolean {
  const last = name.at(-1) ?? "";
  if (name.length > 1 && LIBRARY_SCHEMAS.has(name[0] ?? "")) {
    return false;
  }
  return (
    name[0] === "permdock" ||
    last.startsWith("permdock_") ||
    callsHelper(`${last}(`)
  );
}

function originOf(policy: RawPolicy): PolicyOrigin {
  if (policy.tagged || policy.name.startsWith("bsb_")) {
    return "library";
  }
  return policy.calls.some(isProviderCall) ? "provider" : "app";
}

async function deparsed(expr: unknown): Promise<string> {
  if (expr === undefined) {
    return "";
  }
  // SAFETY: readPolicy takes expr from pgsql-parser's own parse tree, which deparse accepts.
  const sql = await deparse(expr as Parameters<typeof deparse>[0]);
  return sql;
}

function commandsOf(command: SqlPolicy["command"]): readonly ReportCommand[] {
  return command === "all" ? COMMANDS : [command];
}

function policyKey(schema: string, table: string, name: string): string {
  return `${schema}.${table}.${name}`.toLowerCase();
}

/**
 * The files `rls report` reads, in the order a later definition replaces an
 * earlier one: migrations, then the declarative schemas, then `rls.out`.
 */
export function reportFiles(
  cwd: string,
  config: PermDockConfig,
): readonly string[] {
  return [
    ...new Set(
      sqlFiles(cwd, [
        ...(config.doctor?.migrations ?? [
          ...MIGRATION_DIRS,
          `${supabaseDir(cwd)}/migrations`,
        ]),
        `${supabaseDir(cwd)}/schemas`,
        ...outFiles(config.rls?.out),
      ]),
    ),
  ];
}

export function droppedPolicy(
  node: Readonly<Record<string, unknown>>,
):
  | { readonly schema: string; readonly table: string; readonly name: string }
  | undefined {
  const objects = node["objects"];
  if (node["removeType"] !== "OBJECT_POLICY" || !Array.isArray(objects)) {
    return undefined;
  }
  const [object]: unknown[] = objects;
  const list: unknown = isRecord(object) ? object["List"] : undefined;
  const items: unknown = isRecord(list) ? list["items"] : undefined;
  const parts = (Array.isArray(items) ? items : []).flatMap((item: unknown) => {
    const string: unknown = isRecord(item) ? item["String"] : undefined;
    return isRecord(string) && typeof string["sval"] === "string"
      ? [string["sval"]]
      : [];
  });
  const name = parts.at(-1);
  const table = parts.at(-2);
  const schema = parts.length > 2 ? parts.at(-3) : "public";
  return name === undefined || table === undefined || schema === undefined
    ? undefined
    : { schema, table, name };
}

/**
 * The policies the schema files and migrations leave defined, with the policies
 * the `@bsb access` tags render. A file libpg_query rejects throws
 * `SqlSyntaxError` with its line.
 */
async function policiesFromFiles(
  cwd: string,
  config: PermDockConfig,
): Promise<readonly RawPolicy[]> {
  const byKey = new Map<string, RawPolicy>();
  for (const file of reportFiles(cwd, config)) {
    let nodes: Awaited<ReturnType<typeof parseSqlFile>>;
    try {
      nodes = await parseSqlFile(readFileSync(file, "utf8"));
    } catch (error) {
      if (error instanceof SqlSyntaxError) {
        throw new SqlSyntaxError(
          `${rel(cwd, file)}: ${error.message.replace(/ \(line \d+, column \d+\)$/u, "")}`,
          error.line,
          error.column,
        );
      }
      throw error;
    }
    for (const node of nodes) {
      if (node.kind === "DropStmt") {
        const dropped = droppedPolicy(node.node);
        if (dropped !== undefined) {
          byKey.delete(policyKey(dropped.schema, dropped.table, dropped.name));
        }
        continue;
      }
      const policy = readPolicy(node);
      if (policy === undefined) {
        continue;
      }
      byKey.set(policyKey(policy.schema, policy.table, policy.name), {
        schema: policy.schema,
        table: policy.table,
        name: policy.name,
        command: policy.command,
        roles: policy.roles,
        permissive: policy.permissive,
        calls: [...sqlCalls(policy.using), ...sqlCalls(policy.check)].map(
          (call) => call.name,
        ),
        body: `${await deparsed(policy.using)} ${await deparsed(policy.check)}`,
        tagged: false,
        file: rel(cwd, file),
        line: node.line,
      });
    }
  }
  for (const tagged of await taggedAccessPolicies(cwd)) {
    const command = tagged.operation.toLowerCase();
    byKey.set(policyKey(tagged.schema, tagged.table, tagged.name), {
      schema: tagged.schema,
      table: tagged.table,
      name: tagged.name,
      command: isPolicyCommand(command) ? command : "all",
      roles: ["authenticated"],
      permissive: true,
      calls: [],
      body: "",
      tagged: true,
    });
  }
  return [...byKey.values()];
}

/** `pg_policies` and the non-leakproof indexed columns, for one database. */
export const REPORT_POLICIES_SQL = `select schemaname, tablename, policyname, permissive, roles::text[] as roles, cmd, qual, with_check
from pg_policies
where schemaname not in ('pg_catalog', 'information_schema')
order by schemaname, tablename, policyname`;

/**
 * Each column of a btree index on a table with row level security whose
 * equality operator is not leakproof, such as `anyenum = anyenum`: Postgres
 * applies the policies before such a filter, so the filter cannot use the
 * index.
 */
export const NON_LEAKPROOF_INDEXED_SQL = `select n.nspname as schema, c.relname as "table", a.attname as "column", format_type(a.atttypid, a.atttypmod) as type
from pg_index i
join pg_class c on c.oid = i.indrelid and c.relrowsecurity
join pg_namespace n on n.oid = c.relnamespace
cross join lateral unnest(i.indkey::int2[], i.indclass::oid[]) as k(attnum, opclass)
join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
join pg_opclass oc on oc.oid = k.opclass
join pg_am am on am.oid = oc.opcmethod and am.amname = 'btree'
join pg_amop ao on ao.amopfamily = oc.opcfamily and ao.amopstrategy = 3
  and ao.amoplefttype = oc.opcintype and ao.amoprighttype = oc.opcintype
join pg_operator o on o.oid = ao.amopopr
join pg_proc p on p.oid = o.oprcode
where not p.proleakproof and n.nspname not in ('pg_catalog', 'information_schema')
group by 1, 2, 3, 4
order by 1, 2, 3`;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function expressionCalls(
  sql: string,
): Promise<readonly (readonly string[])[]> {
  if (sql.trim() === "") {
    return [];
  }
  try {
    const [node] = await parseSqlFile(`select ${sql};`);
    return sqlCalls(node?.node).map((call) => call.name);
  } catch (error) {
    if (error instanceof SqlSyntaxError) {
      return [];
    }
    throw error;
  }
}

function databaseCommand(value: unknown): SqlPolicy["command"] {
  const command = text(value).toLowerCase();
  return isPolicyCommand(command) ? command : "all";
}

type Leaky = Readonly<
  Record<string, readonly { readonly column: string; readonly type: string }[]>
>;

async function fromDatabase(
  db: string,
  connect: SqlConnect,
): Promise<{ readonly policies: readonly RawPolicy[]; readonly leaky: Leaky }> {
  const client = await connect(db);
  try {
    const rows = (await client.query(REPORT_POLICIES_SQL, [])).rows;
    const policies: RawPolicy[] = [];
    for (const row of rows) {
      if (isStripeDataPipelineSchema(text(row["schemaname"]))) {
        continue;
      }
      const qual = text(row["qual"]);
      const check = text(row["with_check"]);
      policies.push({
        schema: text(row["schemaname"]),
        table: text(row["tablename"]),
        name: text(row["policyname"]),
        command: databaseCommand(row["cmd"]),
        roles: Array.isArray(row["roles"]) ? row["roles"].map(String) : [],
        permissive: row["permissive"] !== "RESTRICTIVE",
        calls: [
          ...(await expressionCalls(qual)),
          ...(await expressionCalls(check)),
        ],
        body: `${qual} ${check}`,
        tagged: false,
      });
    }
    const leaky: Record<string, { column: string; type: string }[]> = {};
    for (const row of (await client.query(NON_LEAKPROOF_INDEXED_SQL, []))
      .rows) {
      const table = `${text(row["schema"])}.${text(row["table"])}`;
      (leaky[table] ??= []).push({
        column: text(row["column"]),
        type: text(row["type"]),
      });
    }
    return { policies, leaky };
  } finally {
    await client.end();
  }
}

function appliesTo(policy: ReportedPolicy, command: ReportCommand): boolean {
  return (
    policy.commands.includes(command) &&
    policy.roles.some((role) => role === "authenticated" || role === "public")
  );
}

function mostCalls(table: ReportedTable): number {
  return Math.max(
    ...COMMANDS.map((command) => table.helperCallsPerStatement[command]),
  );
}

function reportOf(
  source: RlsReport["source"],
  raw: readonly RawPolicy[],
  leaky: Leaky | undefined,
): RlsReport {
  const tables = new Map<string, ReportedPolicy[]>();
  for (const policy of raw) {
    const table = `${policy.schema}.${policy.table}`.toLowerCase();
    const helpers = policy.calls
      .filter(isProviderCall)
      .map((name) => name.join("."));
    const list = tables.get(table) ?? [];
    list.push({
      name: policy.name,
      commands: commandsOf(policy.command),
      roles: policy.roles,
      permissive: policy.permissive,
      origin: originOf(policy),
      helpers: [...new Set(helpers)],
      helperCalls: helpers.length,
      keys: helperCallKeys(policy.body),
      ...(policy.file === undefined ? {} : { file: policy.file }),
      ...(policy.line === undefined ? {} : { line: policy.line }),
    });
    tables.set(table, list);
  }
  const reported = [...tables].map(([table, policies]): ReportedTable => {
    const perStatement = Object.fromEntries(
      COMMANDS.map((command) => [
        command,
        policies
          .filter((policy) => appliesTo(policy, command))
          .reduce((sum, policy) => sum + policy.helperCalls, 0),
      ]),
    );
    const columns = leaky?.[table];
    return {
      table,
      policies: policies.toSorted((a, b) => a.name.localeCompare(b.name)),
      // SAFETY: fromEntries above builds one entry per COMMANDS member.
      helperCallsPerStatement: perStatement as Record<ReportCommand, number>,
      ...(leaky === undefined ? {} : { nonLeakproofIndexed: columns ?? [] }),
    };
  });
  const all = reported.flatMap((table) => table.policies);
  return {
    source,
    tables: reported.toSorted(
      (a, b) => mostCalls(b) - mostCalls(a) || a.table.localeCompare(b.table),
    ),
    totals: {
      policies: all.length,
      library: all.filter((policy) => policy.origin === "library").length,
      provider: all.filter((policy) => policy.origin === "provider").length,
      app: all.filter((policy) => policy.origin === "app").length,
    },
  };
}

/** The policies of one table for one command and `authenticated`. */
export function policiesFor(
  table: ReportedTable,
  command: ReportCommand,
): readonly ReportedPolicy[] {
  return table.policies.filter((policy) => appliesTo(policy, command));
}

export async function rlsReport(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly db?: string;
  readonly connect?: SqlConnect;
  /** `rls.tableReads` of the schema files, counted into the report. */
  readonly tableReads?: readonly SupabaseManifestTableRead[];
}): Promise<RlsReport> {
  const reads =
    input.tableReads === undefined || input.tableReads.length === 0
      ? {}
      : { tableReads: summariseTableReads(input.tableReads) };
  if (input.db !== undefined && input.connect !== undefined) {
    const { policies, leaky } = await fromDatabase(input.db, input.connect);
    return { ...reportOf("database", policies, leaky), ...reads };
  }
  return {
    ...reportOf(
      "files",
      await policiesFromFiles(input.cwd, input.config),
      undefined,
    ),
    ...reads,
  };
}

function renderTable(table: ReportedTable): readonly string[] {
  const calls = COMMANDS.map(
    (command) => `${command} ${String(table.helperCallsPerStatement[command])}`,
  ).join(", ");
  const lines = [`${table.table}: helper calls per statement ${calls}`];
  for (const policy of table.policies) {
    const where =
      policy.file === undefined
        ? ""
        : ` at ${policy.file}:${String(policy.line ?? 1)}`;
    const keys =
      policy.keys.length === 0 ? "" : ` keys ${policy.keys.join(", ")}`;
    const helpers =
      policy.helpers.length === 0 ? "" : ` calls ${policy.helpers.join(", ")}`;
    lines.push(
      `  ${policy.name} (${policy.commands.join(", ")} to ${policy.roles.join(", ")}, ${policy.permissive ? "permissive" : "restrictive"}, ${policy.origin})${helpers}${keys}${where}`,
    );
  }
  for (const column of table.nonLeakproofIndexed ?? []) {
    lines.push(
      `  index on ${column.column} (${column.type}): = is not leakproof, so a filter on it does not use the index under RLS`,
    );
  }
  return lines;
}

function renderTableReads(reads: TableReadsReport): readonly string[] {
  const rules = TABLE_READ_RULES.map(
    (rule) => `${rule} ${String(reads.byRule[rule])}`,
  ).join(", ");
  return [
    `table reads: ${String(reads.tenant)} tenant, ${String(reads.row)} row (${rules})`,
    ...reads.tables
      .filter((read) => read.share === "row")
      .map(
        (read) =>
          `  ${read.table}: ${(read.rules ?? []).join(", ")}${read.reason === undefined ? "" : `; ${read.reason}`}`,
      ),
  ];
}

function renderRlsReport(report: RlsReport): string {
  const { totals } = report;
  return [
    ...report.tables.flatMap(renderTable),
    ...(report.tableReads === undefined
      ? []
      : renderTableReads(report.tableReads)),
    `${String(totals.policies)} policies on ${String(report.tables.length)} tables: ${String(totals.library)} library, ${String(totals.provider)} provider, ${String(totals.app)} app (from ${report.source === "files" ? "the schema files and migrations" : "pg_policies"})`,
  ].join("\n");
}

export async function runRlsReport(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly db?: string;
  readonly connect?: SqlConnect;
  readonly tableReads?: readonly SupabaseManifestTableRead[];
}): Promise<CommandResult> {
  try {
    const report = await rlsReport(input);
    return { code: 0, output: renderRlsReport(report), data: report };
  } catch (error) {
    if (error instanceof SqlSyntaxError) {
      return {
        code: 2,
        reason: "usage",
        output: `PermDock CLI: ${error.message}`,
      };
    }
    throw error;
  }
}
