import type { DoctorFiles, DoctorFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig, RlsTable } from "../types.ts";

import { rel, sqlFiles } from "../files.ts";
import { MIGRATION_DIRS } from "../shared/constants.ts";
import { nodeFiles } from "../shared/doctor-files.ts";
import { tableKey } from "../sql/deciding-columns.ts";
import { group, sqlStatements } from "../sql/statements.ts";
import { permdockSchema } from "./schema-checks.ts";

/** One statement of a schema or migration file. */
type Statement = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** Written by `permdock rls generate`, or by an older release of it. */
  readonly generated: boolean;
};

type Policy = Statement & {
  readonly name: string;
  readonly table: string;
  readonly commands: readonly string[];
  readonly restrictive: boolean;
};

const NAME = String.raw`((?:"[^"]+"|\w+)(?:\s*\.\s*(?:"[^"]+"|\w+))?)`;
const CREATE_POLICY = new RegExp(
  String.raw`^create\s+policy\s+("[^"]+"|\w+)\s+on\s+${NAME}([\s\S]*)$`,
  "iu",
);
const CREATE_INDEX = new RegExp(
  String.raw`^create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:(?:"[^"]+"|\w+)\s+)?on\s+(?:only\s+)?${NAME}\s*(?:using\s+\w+\s*)?\(([^)]*)\)`,
  "iu",
);
const COMMANDS = ["select", "insert", "update", "delete"] as const;
const DOLLAR_BODY = /\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/gu;

/** A statement without its dollar-quoted bodies. */
function header(text: string): string {
  return text.replaceAll(DOLLAR_BODY, "$$$$");
}

function unquote(name: string): string {
  return name.replaceAll(/[\s"]/gu, "").toLowerCase();
}

function statementsOf(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles,
): readonly Statement[] {
  const out = config.rls?.out;
  const entries = [
    ...(config.doctor?.migrations ?? MIGRATION_DIRS),
    "supabase/schemas",
    ...(out === undefined ? [] : [out]),
  ];
  return [...new Set(sqlFiles(cwd, entries))].flatMap((path) => {
    const text = files.read(path);
    const generated = permdockSchema(cwd, { path, text });
    return sqlStatements(text).map((statement): Statement => ({
      file: rel(cwd, path),
      generated,
      ...statement,
    }));
  });
}

function policiesOf(statements: readonly Statement[]): readonly Policy[] {
  return statements.flatMap((statement): Policy[] => {
    const match = CREATE_POLICY.exec(header(statement.text));
    if (match === null) {
      return [];
    }
    const rest = group(match, 3);
    const command = /\bfor\s+(all|select|insert|update|delete)\b/iu
      .exec(rest)?.[1]
      ?.toLowerCase();
    return [
      {
        ...statement,
        name: unquote(group(match, 1)),
        table: tableKey(group(match, 2).replaceAll(/\s/gu, "")),
        commands:
          command === undefined || command === "all" ? COMMANDS : [command],
        restrictive: /\bas\s+restrictive\b/iu.test(rest),
      },
    ];
  });
}

function lineOf(statement: Statement, text: string, index: number): number {
  return statement.line + text.slice(0, index).split("\n").length - 1;
}

const ROW_HELPER = /\bpermitted_\w+_row\s*\(/iu;
/**
 * A `can_<resource>(…)` call. better-supabase's own `can_subject` checks one
 * row per call by design, so a call qualified by its schema is not PermDock's.
 */
const CAN_CALL = /(?<!\bbetter_supabase"?\s*\.\s*"?)\bcan_\w+\s*\(([^)]*)\)/giu;

/** Whether a `can_<resource>(…)` call takes a column of the row it guards. */
function readsRow(args: string): boolean {
  const bare = args
    .replaceAll(/'(?:[^']|'')*'/gu, "")
    .replaceAll(/\(\s*select\s+auth\.\w+\(\)\s*\)/giu, "")
    .replaceAll(/\bauth\.\w+\(\)/giu, "")
    .replaceAll(/\b(?:null|true|false)\b/giu, "");
  return /[A-Za-z_]/u.test(bare);
}

const SET_CALL = /\bpermitted_(\w+)_rows\s*\(\s*'((?:[^']|'')*)'\s*\)/giu;
const SET_FUNCTION =
  /^create\s+(?:or\s+replace\s+)?function\s+(?:(?:"[^"]+"|\w+)\s*\.\s*)?permitted_(\w+)_rows\s*\(\s*p_permission\s+text\s*\)/iu;

/**
 * The bodies of the one-argument set helpers `permitted_<resource>_rows(p)` the
 * project defines, the last definition of each winning as a later migration
 * does.
 */
function setHelperBodies(
  statements: readonly Statement[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const statement of statements) {
    const match = SET_FUNCTION.exec(header(statement.text));
    if (match !== null) {
      out.set(group(match, 1).toLowerCase(), statement.text);
    }
  }
  return out;
}

/**
 * Whether a policy reads a set helper through its fallback: the helper's body
 * has no `when '<key>'` arm for a key the policy passes, so it falls to
 * `permitted_<resource>_match`, a `security definer` function that runs once
 * per row.
 */
function callsSetPerRow(
  text: string,
  helpers: ReadonlyMap<string, string>,
): string | undefined {
  return [...text.matchAll(SET_CALL)]
    .find((call) => {
      const body = helpers.get(group(call, 1).toLowerCase());
      return (
        body !== undefined &&
        !body.includes(`when '${group(call, 2)}'`) &&
        /\bpermitted_\w+_match\s*\(/iu.test(body)
      );
    })?.[0]
    .replaceAll(/\s+/gu, " ");
}

const SET_HELPER_CALL =
  /\b(?:permitted_\w+_(?:rows|rows_for|ids_in|count|permission_keys|permission_keys_for)|permdock_role_permissions)\s*\(/giu;
const SQL_WORDS = new Set([
  "array",
  "as",
  "false",
  "from",
  "in",
  "null",
  "select",
  "true",
  "where",
]);

/** The text between the parenthesis at `open` and the one that closes it. */
function argumentsAt(text: string, open: number): string {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    const char = text[at];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open + 1, at);
      }
    }
  }
  return text.slice(open + 1);
}

/**
 * Whether arguments name a column of the guarded row: a bare identifier, or one
 * qualified by the table's own name. A column of a subquery alias, such as
 * `t.id` over `unnest(…) t(id)`, is not the row.
 */
function namesRowColumn(args: string, table: string): boolean {
  const bare = args
    .replaceAll(/'(?:[^']|'')*'/gu, "")
    .replaceAll(/::\s*[\w.]+(?:\s*\[\s*\])?/gu, "")
    .replaceAll(/\b[\w.]+\s*\(/gu, "(");
  const own = table.slice(table.lastIndexOf(".") + 1);
  for (const match of bare.matchAll(
    /(?<![\w."])("?[A-Za-z_][\w$]*"?)(?:\s*\.\s*("?[A-Za-z_][\w$]*"?))?/gu,
  )) {
    const head = unquote(group(match, 1));
    if (match[2] === undefined) {
      if (!SQL_WORDS.has(head)) {
        return true;
      }
    } else if (head === own) {
      return true;
    }
  }
  return false;
}

/**
 * The first set helper a policy calls with a column of its own row, such as
 * better-supabase's `permitted_<resource>_rows('key', array[id])`: Postgres
 * runs a correlated subquery again for every row.
 */
function correlatedSetCall(text: string, table: string): string | undefined {
  for (const call of text.matchAll(SET_HELPER_CALL)) {
    const open = call.index + call[0].length - 1;
    const args = argumentsAt(text, open);
    if (namesRowColumn(args, table)) {
      return `${call[0]}${args})`.replaceAll(/\s+/gu, " ");
    }
  }
  return undefined;
}

/**
 * PD103: a policy calls a PermDock helper once per row: the row form
 * `permitted_<resource>_row(row, …)`, `can_<resource>(…)` on a column of the
 * row, a set helper such as `permitted_<resource>_rows('key', array[id])`
 * passed a column of the row, which makes it a correlated subquery, or a set
 * helper `permitted_<resource>_rows('key')` whose body has no arm for the key
 * and so calls `permitted_<resource>_match` for every row. The helpers are
 * `security definer`, so the planner cannot inline them and a table scan makes
 * one call per row.
 */
export function pd103(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  const statements = statementsOf(cwd, config, files);
  const helpers = setHelperBodies(statements);
  return policiesOf(statements).flatMap((policy): DoctorFinding[] => {
    const text = header(policy.text);
    const setCall = callsSetPerRow(text, helpers);
    const correlated = correlatedSetCall(text, policy.table);
    const perRow =
      ROW_HELPER.test(text) ||
      [...text.matchAll(CAN_CALL)].some((call) => readsRow(group(call, 1))) ||
      setCall !== undefined ||
      correlated !== undefined;
    const correlatedDetail =
      correlated === undefined
        ? ""
        : `: ${correlated} takes a column of the row, so the set is read again for every row`;
    const detail =
      setCall === undefined
        ? correlatedDetail
        : `: ${setCall} has no arm for its key and calls permitted_*_match for every row`;
    return perRow
      ? [
          {
            code: "PD103",
            severity: "warning",
            target: `${policy.file}:${policy.table}:${policy.name}`,
            message: `${policy.file}:${String(policy.line)} policy ${policy.name} on ${policy.table} calls a PermDock helper once per row${detail}`,
            fix: "lead with the tenant: <tenant column> = any((select permdock.permitted_<scope>_id_array('<key>'))); run permdock rls generate for a generated policy, which writes a set helper that states each key's arm",
          },
        ]
      : [];
  });
}

/**
 * PD104: two permissive policies cover one command of a table and the app wrote
 * one of them. Postgres evaluates every permissive policy and ORs the results,
 * so each added policy adds a predicate to every scan.
 */
export function pd104(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  const groups = new Map<string, Policy[]>();
  for (const policy of policiesOf(statementsOf(cwd, config, files))) {
    if (policy.restrictive) {
      continue;
    }
    for (const command of policy.commands) {
      const key = `${policy.table}:${command}`;
      groups.set(key, [...(groups.get(key) ?? []), policy]);
    }
  }
  const findings: DoctorFinding[] = [];
  for (const [key, policies] of groups) {
    const names = [...new Set(policies.map((policy) => policy.name))];
    if (names.length < 2 || policies.every((policy) => policy.generated)) {
      continue;
    }
    findings.push({
      code: "PD104",
      severity: "warning",
      target: key,
      message: `${key.replace(":", " ")} has ${String(names.length)} permissive policies (${names.join(", ")}), and Postgres evaluates all of them`,
      fix: "merge the app policy into the generated predicate, or make it restrictive",
    });
  }
  return findings;
}

function indexedColumns(
  statements: readonly Statement[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const leads = new Map<string, Set<string>>();
  for (const statement of statements) {
    const match = CREATE_INDEX.exec(header(statement.text));
    if (match === null) {
      continue;
    }
    const first = group(match, 2).split(",")[0]?.trim() ?? "";
    const column = unquote(first.split(/\s+/u)[0] ?? "");
    const table = tableKey(group(match, 1).replaceAll(/\s/gu, ""));
    leads.set(table, (leads.get(table) ?? new Set<string>()).add(column));
  }
  return leads;
}

type Wanted = {
  readonly table: string;
  readonly column: string;
  readonly role: string;
};

function tableOf(resource: string, entry: RlsTable): string | undefined {
  if (entry === false || typeof entry === "string") {
    return entry === false ? undefined : tableKey(entry);
  }
  if ("tableOf" in entry) {
    return undefined;
  }
  return tableKey(entry.table ?? resource);
}

function wantedIndexes(config: PermDockConfig): readonly Wanted[] {
  const wanted: Wanted[] = [];
  for (const [resource, entry] of Object.entries(config.rls?.tables ?? {})) {
    const table = tableOf(resource, entry);
    if (table === undefined || typeof entry !== "object") {
      continue;
    }
    if ("tableOf" in entry) {
      continue;
    }
    for (const [child, column] of Object.entries(entry.follows ?? {})) {
      wanted.push({
        table: tableKey(child),
        column,
        role: `follows ${resource}`,
      });
    }
    if (entry.walk !== undefined && entry.user !== undefined) {
      wanted.push({ table, column: entry.user, role: "walk user" });
    }
    if (entry.via !== undefined) {
      if (entry.via.key !== undefined) {
        wanted.push({ table, column: entry.via.key, role: "parent key" });
      }
      wanted.push({
        table: tableKey(entry.via.table),
        column: entry.via.column,
        role: "parent scope column",
      });
    }
  }
  return wanted;
}

/**
 * PD105: a `follows` foreign key, a `via` parent column or a `walk` user column
 * leads no index in the schema or migrations. The generated policies and
 * helpers filter and join on it, so each lookup scans the table.
 */
export function pd105(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  const wanted = wantedIndexes(config);
  if (wanted.length === 0) {
    return [];
  }
  const leads = indexedColumns(statementsOf(cwd, config, files));
  return wanted.flatMap((item): DoctorFinding[] => {
    if (leads.get(item.table)?.has(unquote(item.column)) === true) {
      return [];
    }
    return [
      {
        code: "PD105",
        severity: "warning",
        target: `${item.table}.${item.column}`,
        message: `${item.table}.${item.column} (${item.role}) leads no index, so the policies that read it scan the table`,
        fix: `create index on ${item.table} (${item.column}); permdock rls generate writes it into indexes.sql`,
      },
    ];
  });
}

const TEXT_CAST = /(?:^|[^\w"])[\w."]*id"?\s*::\s*text\b/giu;

/**
 * PD106: a statement of the app's casts a key column to `text`, as in `id::text
 * = any(…)`. The cast hides the column from its index, so the statement scans
 * the table. Cast the other side to the column's type.
 */
export function pd106(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  return statementsOf(cwd, config, files)
    .filter((statement) => !statement.generated)
    .flatMap((statement): DoctorFinding[] => {
      const first = [...statement.text.matchAll(TEXT_CAST)][0];
      if (first === undefined) {
        return [];
      }
      const line = lineOf(statement, statement.text, first.index);
      return [
        {
          code: "PD106",
          severity: "warning",
          target: `${statement.file}:${String(line)}`,
          message: `${statement.file}:${String(line)} casts a key column to text, which the column's index cannot serve`,
          fix: "cast the other side to the column type: id = any(ids::uuid[]) instead of id::text = any(ids)",
        },
      ];
    });
}

const CUSTOM_ROLE_TABLE = /\bcustom_role_(?:permissions|includes)\b/iu;
const UNSARGABLE_TENANT =
  /\btenant_id"?\s*::\s*text\b|\btenant_id"?\s+is\s+not\s+distinct\s+from\b/iu;

/**
 * PD107: a statement reads a custom-role table and compares `tenant_id` through
 * a `text` cast or `is not distinct from`. Neither form can use the table's
 * `(tenant_id, …)` index, so each probe scans every tenant's roles.
 */
export function pd107(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  return statementsOf(cwd, config, files).flatMap((statement) => {
    if (!CUSTOM_ROLE_TABLE.test(statement.text)) {
      return [];
    }
    const match = UNSARGABLE_TENANT.exec(statement.text);
    if (match === null) {
      return [];
    }
    return [
      {
        code: "PD107",
        severity: "warning" as const,
        target: `${statement.file}:${String(statement.line)}`,
        message: `${statement.file}:${String(statement.line)} probes a custom-role table with ${match[0].trim()}, which cannot use the tenant index`,
        fix: "compare tenant_id = $tenant::uuid with explicit null branches; permdock rls generate writes that form",
      },
    ];
  });
}

const ROWS_CALL = /\bpermitted_\w+_rows\s*\(\s*([^()]*?)\s*\)/giu;
const TENANT_LEAD =
  /\bpermitted_\w+_id_array\s*\(|\bpermitted_\w+_ids_by_permission\s*\(|\bpermdock_tenant_has\s*\(/iu;

/**
 * PD108: an app policy calls `permitted_<resource>_rows(p)` with no tenant
 * argument and no tenant-led predicate beside it. The set covers every tenant
 * the caller can read, so a query for one tenant still scans all of them. A
 * generated policy reads the one-argument form only where no tenant can lead
 * it, so it is not reported.
 */
export function pd108(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  return policiesOf(statementsOf(cwd, config, files)).flatMap(
    (policy): DoctorFinding[] => {
      if (policy.generated) {
        return [];
      }
      const text = header(policy.text);
      const alone = [...text.matchAll(ROWS_CALL)].some(
        (call) => !group(call, 1).includes(","),
      );
      if (!alone || TENANT_LEAD.test(text)) {
        return [];
      }
      return [
        {
          code: "PD108",
          severity: "warning",
          target: `${policy.file}:${policy.table}:${policy.name}`,
          message: `${policy.file}:${String(policy.line)} policy ${policy.name} on ${policy.table} reads permitted_*_rows without a tenant, so it covers every tenant the caller can read`,
          fix: "lead with <tenant column> = any((select permdock.permitted_<scope>_id_array(p))); a tenant argument read from the row, permitted_<resource>_rows(p, <tenant column>), runs once per row (PD103)",
        },
      ];
    },
  );
}
