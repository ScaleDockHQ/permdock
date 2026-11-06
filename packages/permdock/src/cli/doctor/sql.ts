import { join } from "node:path";

import type { DoctorFiles, DoctorFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { rel, sqlFiles } from "../files.ts";
import {
  legacyHelperCalls,
  legacyHelperNames,
  retirePlan,
} from "../rls/retire.ts";
import { MIGRATION_DIRS } from "../shared/constants.ts";
import { nodeFiles } from "../shared/doctor-files.ts";
import { tableKey } from "../sql/deciding-columns.ts";
import { group, sqlStatements } from "../sql/statements.ts";
import { supautilsRejections } from "../sql/supautils.ts";
import { supabaseConfig } from "../supabase-config.ts";

/** One statement of a migration: comments blanked, its file and first line. */
type SqlStatement = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
};

/** Supabase's `[api] schemas` when `config.toml` sets none. */
const API_SCHEMAS = ["public", "graphql_public"] as const;

const NAME = String.raw`((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)`;
const IDENT = String.raw`("[^"]+"|\w+)`;

/** A statement without its dollar-quoted bodies: what a function header says. */
function header(text: string): string {
  return text.replaceAll(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/gu, "$$$$");
}

function isSupabase(
  files: DoctorFiles,
  cwd: string,
  config: PermDockConfig,
): boolean {
  return (
    files.exists(join(cwd, "supabase")) ||
    config.rls?.dialect === "supabase" ||
    config.supabase !== undefined
  );
}

function migrationStatements(
  files: DoctorFiles,
  cwd: string,
  config: PermDockConfig,
): readonly SqlStatement[] {
  return sqlFiles(cwd, config.doctor?.migrations ?? MIGRATION_DIRS).flatMap(
    (file) =>
      sqlStatements(files.read(file)).map((statement) =>
        Object.assign({ file: rel(cwd, file) }, statement),
      ),
  );
}

/** The schema of a `tableKey`, which always names one. */
function schemaOf(key: string): string {
  return key.slice(0, key.indexOf("."));
}

function unquote(name: string): string {
  return name.replaceAll('"', "").toLowerCase();
}

/**
 * PD046: the schema of PermDock's `security definer` helpers is one the Data
 * API exposes, so PostgREST serves them as RPCs.
 */
export function pd046(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  if (!files.exists(join(cwd, "supabase/config.toml"))) {
    return [];
  }
  const schema =
    config.rls?.schema ?? config.rls?.rbac?.schema ?? PERMDOCK_SCHEMA;
  const exposed = supabaseConfig(cwd).apiSchemas ?? API_SCHEMAS;
  if (!exposed.includes(schema)) {
    return [];
  }
  return [
    {
      code: "PD046",
      severity: "warning",
      message: `the PermDock helper schema ${schema} is in [api] schemas in supabase/config.toml, so the Data API serves its security definer helpers as RPCs`,
      fix:
        schema === "public"
          ? `drop rls.schema: 'public' so the helpers move to the private ${PERMDOCK_SCHEMA} schema, regenerate with permdock rls generate, and keep ${PERMDOCK_SCHEMA} out of [api] schemas`
          : `remove ${schema} from [api] schemas; policies reach the helpers through grant usage, not the Data API`,
    },
  ];
}

const USER_METADATA = /\b(raw_user_meta_data|user_metadata)\b/giu;

/**
 * PD047: SQL that reads `user_metadata`, which every user can edit for
 * themselves.
 */
export function pd047(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  if (!isSupabase(files, cwd, config)) {
    return [];
  }
  return migrationStatements(files, cwd, config).flatMap((statement) =>
    [...statement.text.matchAll(USER_METADATA)].map((match) => ({
      code: "PD047",
      severity: "warning" as const,
      message: `${statement.file}:${String(statement.line + statement.text.slice(0, match.index).split("\n").length - 1)} reads ${match[0]}, which a user can set for themselves`,
      fix: "decide access from app_metadata (raw_app_meta_data), a server-owned table or a hook claim; user_metadata is for display only",
    })),
  );
}

const CREATE_FUNCTION = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?function\s+${NAME}\s*\(`,
  "iu",
);
const ALTER_SEARCH_PATH = new RegExp(
  String.raw`^alter\s+function\s+${NAME}\s*(?:\([^)]*\))?\s+set\s+search_path\b`,
  "iu",
);
const REVOKE_EXECUTE = new RegExp(
  String.raw`^revoke\s+(?:all(?:\s+privileges)?|execute)\s+on\s+(?:function|routine)\s+${NAME}\s*(?:\([^)]*\))?\s+from\s+([\s\S]+)$`,
  "iu",
);
const REVOKE_ALL_FUNCTIONS = new RegExp(
  String.raw`^(?:alter\s+default\s+privileges\s+(?:for\s+role\s+\S+\s+)?in\s+schema\s+${IDENT}\s+)?revoke\s+(?:all(?:\s+privileges)?|execute)\s+on\s+(?:all\s+)?(?:functions|routines)(?:\s+in\s+schema\s+${IDENT})?\s+from\s+([\s\S]+)$`,
  "iu",
);

type CreatedFunction = SqlStatement & {
  readonly key: string;
  readonly head: string;
};

function createdFunctions(
  statements: readonly SqlStatement[],
): readonly CreatedFunction[] {
  return statements.flatMap((statement) => {
    const match = CREATE_FUNCTION.exec(statement.text);
    return match === null
      ? []
      : [
          {
            ...statement,
            key: tableKey(group(match, 1)),
            head: header(statement.text),
          },
        ];
  });
}

/**
 * PD048: a function without `set search_path`, so a caller's objects can shadow
 * the ones it names.
 */
export function pd048(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  if (!isSupabase(files, cwd, config)) {
    return [];
  }
  const statements = migrationStatements(files, cwd, config);
  const altered = new Set(
    statements.flatMap((statement) => {
      const match = ALTER_SEARCH_PATH.exec(statement.text);
      return match === null ? [] : [tableKey(group(match, 1))];
    }),
  );
  return createdFunctions(statements)
    .filter(
      (fn) =>
        !/\bset\s+search_path\b/iu.test(fn.head) &&
        !altered.has(fn.key) &&
        !/\blanguage\s+(?:c|internal)\b/iu.test(fn.head),
    )
    .map((fn) => {
      const definer = /\bsecurity\s+definer\b/iu.test(fn.head);
      return {
        code: "PD048",
        severity: "warning" as const,
        message: `${fn.file}:${String(fn.line)} ${definer ? "security definer " : ""}function ${fn.key} sets no search_path${definer ? ", so a caller can shadow what it reads with their own objects" : ""}`,
        fix: `add set search_path = '' and qualify every name in the body (Supabase advisor function_search_path_mutable)`,
      };
    });
}

/**
 * Roles each `revoke` statement takes `execute` from, per function key or
 * `schema.*`.
 */
function revokedExecute(
  statements: readonly SqlStatement[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const revoked = new Map<string, Set<string>>();
  const add = (key: string, roles: string): void => {
    const set = revoked.get(key) ?? new Set<string>();
    for (const role of roles.split(",")) {
      set.add(unquote(role.trim().replace(/\s+(?:cascade|restrict)$/iu, "")));
    }
    revoked.set(key, set);
  };
  for (const statement of statements) {
    const one = REVOKE_EXECUTE.exec(statement.text);
    if (one !== null) {
      add(tableKey(group(one, 1)), group(one, 2));
      continue;
    }
    const all = REVOKE_ALL_FUNCTIONS.exec(statement.text);
    if (all !== null) {
      const schema = all[1] ?? all[2];
      add(`${schema === undefined ? "*" : unquote(schema)}.*`, group(all, 3));
    }
  }
  return revoked;
}

/**
 * `supabase.hook.claims` and `hook.before` functions, by key, with the argument
 * type the hook calls them with.
 */
function hookClaimFunctions(
  config: PermDockConfig,
): ReadonlyMap<string, "uuid" | "jsonb"> {
  const hook = config.supabase?.hook;
  const before = hook?.before;
  const functions = new Map<string, "uuid" | "jsonb">();
  for (const fn of Object.values(hook?.claims ?? {})) {
    if (typeof fn === "string") {
      functions.set(tableKey(fn), "uuid");
    }
  }
  for (const fn of typeof before === "string" ? [before] : (before ?? [])) {
    if (typeof fn === "string") {
      functions.set(tableKey(fn), "jsonb");
    }
  }
  return functions;
}

/**
 * PD049: a `security definer` function `public` (every role) or, in Supabase's
 * `public` schema, `anon` may still execute: Postgres grants `execute` to
 * `public` on create, and Supabase's default privileges grant it to `anon`. A
 * hook claim function returns any user's claims, so `authenticated` must not
 * execute it either, definer or not.
 */
export function pd049(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  if (!isSupabase(files, cwd, config)) {
    return [];
  }
  const statements = migrationStatements(files, cwd, config);
  const revoked = revokedExecute(statements);
  const hookFunctions = hookClaimFunctions(config);
  const findings: DoctorFinding[] = [];
  for (const fn of createdFunctions(statements)) {
    const hookArgument = hookFunctions.get(fn.key);
    if (
      hookArgument === undefined &&
      (!/\bsecurity\s+definer\b/iu.test(fn.head) ||
        /\breturns\s+(?:event_)?trigger\b/iu.test(fn.head))
    ) {
      continue;
    }
    const schema = schemaOf(fn.key);
    const from = new Set([
      ...(revoked.get(fn.key) ?? []),
      ...(revoked.get(`${schema}.*`) ?? []),
      ...(revoked.get("*.*") ?? []),
    ]);
    const roles =
      hookArgument === undefined
        ? ["public", ...(schema === "public" ? ["anon"] : [])]
        : ["public", "anon", "authenticated"];
    const missing = roles.filter((role) => !from.has(role));
    if (missing.length > 0 && hookArgument !== undefined) {
      findings.push({
        code: "PD049",
        severity: "warning",
        message: `${fn.file}:${String(fn.line)} hook claim function ${fn.key} returns any user's claims and can be executed by ${missing.join(" and ")}`,
        fix: `regenerate the hook (permdock rls generate), which revokes it, or add revoke all on function ${fn.key}(${hookArgument}) from public, anon, authenticated;`,
      });
      continue;
    }
    if (missing.length > 0) {
      findings.push({
        code: "PD049",
        severity: "warning",
        message: `${fn.file}:${String(fn.line)} security definer function ${fn.key} can be executed by ${missing.join(" and ")}`,
        fix: `revoke execute on function ${fn.key}(…) from public, anon; then grant execute to the roles that call it`,
      });
    }
  }
  return findings;
}

const CREATE_TABLE = new RegExp(
  String.raw`^create\s+(?:(?:global|local)\s+)?(?:(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}\s*\(`,
  "iu",
);
const ENABLE_RLS = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}[\s\S]*\benable\s+row\s+level\s+security\b`,
  "iu",
);
const DROP_TABLE =
  /^drop\s+table\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+(?:cascade|restrict))?$/iu;

/**
 * PD050: a `public` table without row level security, which the Data API serves
 * whole.
 */
export function pd050(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  if (!isSupabase(files, cwd, config)) {
    return [];
  }
  const created = new Map<string, SqlStatement>();
  const enabled = new Set<string>();
  for (const statement of migrationStatements(files, cwd, config)) {
    const table = CREATE_TABLE.exec(statement.text);
    if (table !== null) {
      created.set(tableKey(group(table, 1)), statement);
      continue;
    }
    const rls = ENABLE_RLS.exec(statement.text);
    if (rls !== null) {
      enabled.add(tableKey(group(rls, 1)));
      continue;
    }
    const dropped = DROP_TABLE.exec(statement.text);
    if (dropped !== null) {
      for (const name of group(dropped, 1).split(",")) {
        created.delete(tableKey(name.trim()));
      }
    }
  }
  return [...created]
    .filter(([key]) => schemaOf(key) === "public" && !enabled.has(key))
    .map(([key, statement]) => ({
      code: "PD050",
      severity: "error",
      message: `${statement.file}:${String(statement.line)} creates ${key} without row level security, so the Data API serves every row to anon and authenticated`,
      fix: `alter table ${key} enable row level security; permdock rls generate writes its policies`,
    }));
}

const CREATE_POLICY = new RegExp(
  String.raw`^create\s+policy\s+${IDENT}\s+on\s+${NAME}([\s\S]*)$`,
  "iu",
);
const UNWRAPPED_AUTH = /(?<!\bselect\s{1,20})\bauth\.(uid|jwt)\s*\(\s*\)/giu;

/**
 * PD051: a policy that calls `auth.uid()` or `auth.jwt()` bare, so Postgres
 * runs it once per row.
 */
export function pd051(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  if (!isSupabase(files, cwd, config)) {
    return [];
  }
  return migrationStatements(files, cwd, config).flatMap((statement) => {
    const policy = CREATE_POLICY.exec(statement.text);
    if (policy === null) {
      return [];
    }
    const calls = [
      ...new Set(
        [...group(policy, 3).matchAll(UNWRAPPED_AUTH)].map(
          (match) => `auth.${group(match, 1).toLowerCase()}()`,
        ),
      ),
    ];
    const [first] = calls;
    return first === undefined
      ? []
      : [
          {
            code: "PD051",
            severity: "warning" as const,
            message: `${statement.file}:${String(statement.line)} policy ${unquote(group(policy, 1))} on ${tableKey(group(policy, 2))} calls ${calls.join(" and ")} once per row`,
            fix: `wrap each call as (select ${first}) so Postgres evaluates it once per statement (Supabase advisor auth_rls_initplan)`,
          },
        ];
  });
}

/**
 * PD052: an update policy without `with check`, so nothing states what a row
 * may become.
 */
export function pd052(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  if (!isSupabase(files, cwd, config)) {
    return [];
  }
  return migrationStatements(files, cwd, config).flatMap((statement) => {
    const policy = CREATE_POLICY.exec(statement.text);
    const rest = policy?.[3] ?? "";
    if (
      policy === null ||
      !/\bfor\s+update\b/iu.test(rest) ||
      /\bwith\s+check\b/iu.test(rest)
    ) {
      return [];
    }
    return [
      {
        code: "PD052",
        severity: "warning" as const,
        message: `${statement.file}:${String(statement.line)} update policy ${unquote(group(policy, 1))} on ${tableKey(group(policy, 2))} has no with check, so Postgres checks the new row against using alone`,
        fix: "add with check (...) stating what the updated row must satisfy, such as the same tenant and owner test, so an update cannot move a row out of what the user may write",
      },
    ];
  });
}

/** Top-level comma-separated parts of a parenthesised list. */
function topLevelParts(body: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(body.slice(start).trim());
  return parts.filter((part) => part !== "");
}

/**
 * One column definition or table constraint of a `create table` body: its first
 * column, whether it is a foreign key, and whether a primary key or unique
 * constraint indexes that column.
 */
function tablePart(raw: string): {
  readonly column: string;
  readonly foreign: boolean;
  readonly indexed: boolean;
} {
  const part = raw.replace(/^constraint\s+(?:"[^"]+"|\w+)\s+/iu, "");
  const listed = /^(foreign\s+key|primary\s+key|unique)\s*\(([^)]*)\)/iu.exec(
    part,
  );
  if (listed !== null) {
    const foreign = /^foreign/iu.test(group(listed, 1));
    return {
      column: firstColumn(group(listed, 2)),
      foreign,
      indexed: !foreign,
    };
  }
  return {
    column: unquote(/^("[^"]+"|\w+)/u.exec(part)?.[1] ?? ""),
    foreign: /\breferences\b/iu.test(part),
    indexed: /\b(?:primary\s+key|unique)\b/iu.test(part),
  };
}

function firstColumn(list: string): string {
  return unquote(list.replace(/,[\s\S]*$/u, "").trim());
}

type ForeignKey = SqlStatement & {
  readonly table: string;
  readonly column: string;
};

const ADD_CONSTRAINT = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+add\s+(?:constraint\s+${IDENT}\s+)?(foreign\s+key|primary\s+key|unique)\s*\(([^)]*)\)`,
  "iu",
);
const CREATE_INDEX = new RegExp(
  String.raw`^create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:${IDENT}\s+)?on\s+(?:only\s+)?${NAME}\s*(?:using\s+\w+\s*)?\(\s*${IDENT}`,
  "iu",
);

/**
 * PD053: a foreign key no index starts with, so joins and deletes on the
 * referenced row scan the table.
 */
export function pd053(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  if (!isSupabase(files, cwd, config)) {
    return [];
  }
  const keys: ForeignKey[] = [];
  const indexed = new Set<string>();
  for (const statement of migrationStatements(files, cwd, config)) {
    const table = CREATE_TABLE.exec(statement.text);
    if (table !== null) {
      const key = tableKey(group(table, 1));
      const open = statement.text.indexOf("(", table[0].length - 1);
      const body = statement.text.slice(
        open + 1,
        statement.text.lastIndexOf(")"),
      );
      for (const raw of topLevelParts(body)) {
        const found = tablePart(raw);
        if (found.foreign) {
          keys.push({ ...statement, table: key, column: found.column });
        }
        if (found.indexed) {
          indexed.add(`${key}.${found.column}`);
        }
      }
      continue;
    }
    const added = ADD_CONSTRAINT.exec(statement.text);
    if (added !== null) {
      const key = tableKey(group(added, 1));
      const column = firstColumn(group(added, 4));
      if (/^foreign/iu.test(group(added, 3))) {
        keys.push({ ...statement, table: key, column });
      } else {
        indexed.add(`${key}.${column}`);
      }
      continue;
    }
    const index = CREATE_INDEX.exec(statement.text);
    if (index !== null) {
      indexed.add(`${tableKey(group(index, 2))}.${unquote(group(index, 3))}`);
    }
  }
  return keys
    .filter((fk) => !indexed.has(`${fk.table}.${fk.column}`))
    .map((fk) => ({
      code: "PD053",
      severity: "warning",
      message: `${fk.file}:${String(fk.line)} ${fk.table}.${fk.column} is a foreign key no index starts with, so policies that join on it and deletes of the referenced row scan ${fk.table}`,
      fix: `create index on ${fk.table} (${fk.column}); (Supabase advisor unindexed_foreign_keys)`,
    }));
}

const LEGACY_CLAIM = /\brequest\.jwt\.claim\.(\w+)/giu;

function at(statement: SqlStatement): string {
  return `${statement.file}:${String(statement.line)}`;
}

/**
 * PD062: SQL that reads or sets a per-claim `request.jwt.claim.<name>` setting.
 * Current PostgREST, `withPostgresClient`, PermDock's `withSubject` and `rls
 * verify` set only `request.jwt.claims`. A function replaced by a later
 * migration is judged by its last definition.
 */
export function pd062(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  if (!isSupabase(files, cwd, config)) {
    return [];
  }
  const statements = migrationStatements(files, cwd, config);
  const latest = new Map<string, string>();
  for (const fn of createdFunctions(statements)) {
    latest.set(fn.key, at(fn));
  }
  return statements.flatMap((statement) => {
    const fn = CREATE_FUNCTION.exec(statement.text);
    if (fn !== null && latest.get(tableKey(group(fn, 1))) !== at(statement)) {
      return [];
    }
    const names = [
      ...new Set(
        [...statement.text.matchAll(LEGACY_CLAIM)].map((match) =>
          group(match, 1).toLowerCase(),
        ),
      ),
    ];
    return names.map((name) => ({
      code: "PD062",
      severity: "warning" as const,
      message: `${statement.file}:${String(statement.line)} uses the legacy request.jwt.claim.${name} setting, which PostgREST 12 and PermDock's withSubject no longer set, so it reads null`,
      fix:
        name === "sub"
          ? "read the subject with (select permdock.permdock_user_id()) or (select auth.uid()), and set request.jwt.claims in tests and jobs"
          : `read (select auth.jwt()) ->> '${name}', and set request.jwt.claims in tests and jobs`,
    }));
  });
}

/**
 * PD063: a migration statement supautils rejects for `postgres`, so `supabase
 * db push` fails on it.
 */
export function pd063(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  if (!isSupabase(files, cwd, config)) {
    return [];
  }
  return sqlFiles(cwd, config.doctor?.migrations ?? MIGRATION_DIRS).flatMap(
    (file) =>
      supautilsRejections(files.read(file)).map((found) => ({
        code: "PD063",
        severity: "error" as const,
        message: `${rel(cwd, file)}:${String(found.line)} ${found.reason}, which supautils rejects for the postgres role on Supabase`,
        fix: "remove the statement: reserved roles belong to Supabase. Grant your own role to authenticator instead, and change anon, authenticated, authenticator or service_role only with alter role … set",
      })),
  );
}

/**
 * PD056: SQL still calls an `rls.migrate` helper by its legacy name, so the
 * shim (or the legacy function) cannot be dropped yet.
 */
export function pd056(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  const migrate = config.rls?.migrate;
  const helpers = migrate === undefined ? [] : legacyHelperNames(migrate);
  if (helpers.length === 0) {
    return [];
  }
  const statements = migrationStatements(files, cwd, config);
  const findings: DoctorFinding[] = [];
  for (const name of helpers) {
    const { count, files: callers } = legacyHelperCalls(statements, name);
    if (count === 0) {
      continue;
    }
    findings.push({
      code: "PD056",
      severity: "warning",
      message: `legacy helper ${name} is still called ${String(count)} time(s), in ${callers.join(", ")}`,
      fix: `run permdock rls migrate for policies, rewrite function bodies, views and triggers onto the permdock helpers by hand, then drop function ${name}`,
    });
  }
  return findings;
}

/**
 * PD066: the migrations still create an `rls.migrate.tables` table: something
 * still reads it, or `rls migrate --retire-out` can drop it now.
 */
export function pd066(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  const migrate = config.rls?.migrate;
  if (migrate?.tables === undefined) {
    return [];
  }
  const plan = retirePlan(migrationStatements(files, cwd, config), migrate);
  return plan.tables
    .filter((table) => table.present)
    .map((table): DoctorFinding => {
      const [first] = table.readers;
      return first === undefined
        ? {
            code: "PD066",
            severity: "warning",
            message: `${table.table} has no reader left, but the migrations still create it and its ${String(table.refreshTriggers.length)} refresh trigger(s)`,
            fix: "run permdock rls migrate --sql <dir> --retire-out supabase/migrations/ and apply the migration it writes",
          }
        : {
            code: "PD066",
            severity: "warning",
            message: `${table.table} is still read by ${String(table.readers.length)} object(s), first ${first.kind} ${first.name} at ${first.file}:${String(first.line)}`,
            fix: "rewrite each reader onto the permdock helpers, then run permdock rls migrate --retire-out",
          };
    });
}

const ROWS_HELPER = String.raw`(?:"[^"]+"\.|\w+\.)?"?permitted_\w+_rows"?`;
const CAN_HELPER = String.raw`(?:"[^"]+"\.|\w+\.)?"?can_\w+"?`;
const TEXT_CAST_ON_ROWS = new RegExp(
  String.raw`::\s*text\s+in\s*\(\s*select\s+${ROWS_HELPER}\s*\(|${ROWS_HELPER}\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*::\s*text\b|(?:${CAN_HELPER}|permitted_\w+_row)\s*\(\s*[^,()]+::\s*text\s*,`,
  "iu",
);
const KNOWN_ID = String.raw`(?:\$\d+|\bp_\w+|\b(?:new|old)\.\w+)(?:\s*::\s*\w+)?`;
const KNOWN_ID_IN_ROWS = new RegExp(
  String.raw`${KNOWN_ID}\s+in\s*\(\s*select\s+${ROWS_HELPER}\s*\(|${KNOWN_ID}\s*=\s*any\s*\(\s*array\s*\(\s*select\s+${ROWS_HELPER}\s*\(`,
  "iu",
);
const GENERATED_ROW_HELPER =
  /^create\s+(?:or\s+replace\s+)?function\s+(?:"?\w+"?\.)?"?permitted_\w+/iu;

function firstLine(statement: SqlStatement, index: number): number {
  return statement.line + statement.text.slice(0, index).split("\n").length - 1;
}

function rowHelperStatements(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles,
): readonly SqlStatement[] {
  return migrationStatements(files, cwd, config).filter(
    (statement) => !CREATE_FUNCTION.test(statement.text),
  );
}

/**
 * PD088: a `::text` cast on a row-helper call. The helpers return the
 * resource's id type, so the cast defeats the index on the id column and fails
 * against a `uuid` helper.
 */
export function pd088(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  if (config.rls?.dialect === "neon" || config.rls?.idTypes?.["*"] === "text") {
    return [];
  }
  return rowHelperStatements(cwd, config, files).flatMap((statement) => {
    const match = TEXT_CAST_ON_ROWS.exec(statement.text);
    return match === null
      ? []
      : [
          {
            code: "PD088",
            severity: "warning" as const,
            message: `${statement.file}:${String(firstLine(statement, match.index))} casts to text around a permitted_*_rows or can_<resource> call`,
            fix: "compare the id column to the helper's own type (uuid by default) and set rls.idTypes when the column is not uuid, then run permdock rls generate",
          },
        ];
  });
}

/**
 * PD089: `<known id> in (select permitted_*_rows(...))` or `<known id> =
 * any(array(select permitted_*_rows(...)))`, in a policy or a function body.
 * The `_rows` helper lists every permitted row; for one id the
 * `can_<resource>(id, permission)` form checks that row alone.
 */
export function pd089(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  // Function bodies count: a hand-written `may_read(p_id)` wrapper tests one id.
  const statements = migrationStatements(files, cwd, config).filter(
    (statement) => !GENERATED_ROW_HELPER.test(statement.text),
  );
  return statements.flatMap((statement) => {
    const match = KNOWN_ID_IN_ROWS.exec(statement.text);
    return match === null
      ? []
      : [
          {
            code: "PD089",
            severity: "warning" as const,
            message: `${statement.file}:${String(firstLine(statement, match.index))} tests one id against the whole permitted_*_rows set`,
            fix: "call can_<resource>(id, permission), which evaluates that row only",
          },
        ];
  });
}

const POLICY_COMMAND = /\bfor\s+(all|select|insert|update|delete)\b/iu;
const ACTOR_GUARD_CALL = /\bpermdock_actor_may_write\s*\(/iu;
/** The expression `rls generate` inlined into the policies of 0.24 and earlier. */
const INLINED_ACTOR_GUARD = /'act'[\s\S]*'read_only'/iu;

function inlinesActorGuard(text: string): boolean {
  return INLINED_ACTOR_GUARD.test(text.replaceAll('"', ""));
}
const WRITE_COMMANDS = ["insert", "update", "delete"] as const;

type PolicyStatement = SqlStatement & {
  readonly name: string;
  readonly table: string;
  readonly commands: readonly string[];
  readonly guarded: boolean;
};

function policyStatements(
  statements: readonly SqlStatement[],
): readonly PolicyStatement[] {
  return statements.flatMap((statement) => {
    const match = CREATE_POLICY.exec(header(statement.text));
    if (match === null) {
      return [];
    }
    const command = POLICY_COMMAND.exec(group(match, 3))?.[1]?.toLowerCase();
    return [
      {
        ...statement,
        name: unquote(group(match, 1)),
        table: tableKey(group(match, 2)),
        commands:
          command === undefined || command === "all"
            ? WRITE_COMMANDS
            : [command],
        guarded:
          ACTOR_GUARD_CALL.test(statement.text) ||
          inlinesActorGuard(statement.text),
      },
    ];
  });
}

/**
 * The statements PD090 reads: the migration folders, plus the declarative
 * schemas and `rls.out`, which `doctor.migrations` does not drop.
 */
function guardStatements(
  files: DoctorFiles,
  cwd: string,
  config: PermDockConfig,
): readonly SqlStatement[] {
  const out = config.rls?.out;
  const entries = [
    ...(config.doctor?.migrations ?? MIGRATION_DIRS),
    "supabase/schemas",
    ...(out === undefined ? [] : [out]),
  ];
  return [...new Set(sqlFiles(cwd, entries))].flatMap((file) =>
    sqlStatements(files.read(file)).map((statement) =>
      Object.assign({ file: rel(cwd, file) }, statement),
    ),
  );
}

/**
 * PD090: a hand-written policy calls `permdock_actor_may_write()`, or inlines
 * the guard expression of 0.24 and earlier, on a table and command where
 * `permdock rls generate` already writes a restrictive `*_read_only_actors`
 * policy, so the guard runs twice.
 */
export function pd090(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  const policies = policyStatements(guardStatements(files, cwd, config));
  const generated = new Set(
    policies
      .filter((policy) => policy.name.endsWith("_read_only_actors"))
      .flatMap((policy) =>
        policy.commands.map((command) => `${policy.table}:${command}`),
      ),
  );
  return policies
    .filter((policy) => !policy.name.endsWith("_read_only_actors"))
    .filter(
      (policy) =>
        policy.guarded &&
        policy.commands.some((command) =>
          generated.has(`${policy.table}:${command}`),
        ),
    )
    .map((policy) => ({
      code: "PD090",
      severity: "warning" as const,
      message: `${policy.file}:${String(policy.line)} policy ${policy.name} on ${policy.table} repeats the permdock_actor_may_write() guard of the generated read-only actor policy`,
      fix: "remove the permdock_actor_may_write() call from the hand-written policy; the restrictive policy applies to it already",
    }));
}

const OWN_SUBJECT_FUNCTION =
  /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?\w+"?\.)?"?own_subject"?\s*\(/iu;

/**
 * PD093: a migration defines an `own_subject()` function. The hook migration
 * writes `permdock_subject()`, which better-supabase's `functions.subject`
 * names, so a bootstrap seeds the same subject without a second copy.
 */
export function pd093(
  cwd: string,
  config: PermDockConfig,
  files: DoctorFiles = nodeFiles,
): readonly DoctorFinding[] {
  return migrationStatements(files, cwd, config).flatMap((statement) => {
    const match = OWN_SUBJECT_FUNCTION.exec(statement.text);
    return match === null
      ? []
      : [
          {
            code: "PD093",
            severity: "warning" as const,
            message: `${statement.file}:${String(firstLine(statement, match.index))} defines own_subject(), which permdock_subject() from the hook migration already is`,
            fix: "set subject: true on authorizationProvider and drop the function; better-supabase's bootstrap calls permdock_subject()",
          },
        ];
  });
}
