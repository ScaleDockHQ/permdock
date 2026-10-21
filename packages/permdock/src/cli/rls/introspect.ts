import type { SqlClient, SqlConnect } from "../pg.ts";
import type { CompiledPolicy } from "../sql/compile.ts";
import type { RolePermission } from "./helpers.ts";
import type { IndexTarget } from "./indexes.ts";
import type { LevelKey } from "./rows.ts";
import type { RlsFinding } from "./verify-findings.ts";

import { escapeSqlIdent } from "../../core/sql.ts";
import { connectPgPool } from "../pg.ts";
import { beforeFirst } from "../shared/text.ts";
import {
  callsHelper,
  HELPER_TABLES,
  helperCallKeys,
} from "../sql/helper-calls.ts";
import { COLUMNS_SQL, INDEX_COLUMNS_SQL } from "./indexes.ts";
import { ACTOR_MAY_WRITE } from "./policies.ts";
import { rlsFinding } from "./verify-findings.ts";

const ROLES = ["anon", "authenticated"] as const;
/**
 * Neon's `anonymous` is the role `rls generate` writes as `anon` for the other
 * dialects.
 */
function liveRole(role: string): string {
  return role === "anonymous" ? "anon" : role;
}

const PRIVILEGES = ["select", "insert", "update", "delete"] as const;

type Privilege = (typeof PRIVILEGES)[number];

/** What `rls generate` would write, reduced to what the catalogs can confirm. */
export type ExpectedRls = {
  readonly policies: readonly {
    readonly table: string;
    readonly name: string;
    readonly command: string;
    readonly permissive: boolean;
    readonly roles: readonly string[];
  }[];
  readonly tables: readonly string[];
  /** Per table and role, the privileges `grant` leaves after `revoke all`. */
  readonly grants: Readonly<
    Record<string, Readonly<Record<string, readonly Privilege[]>>>
  >;
  /**
   * `security definer` functions, as `schema.name(type, …)` with the input
   * parameter types `oidvectortypes` prints; `*` stands for a `%type`
   * reference.
   */
  readonly helpers: readonly string[];
  /**
   * The indexes the policies and helpers read through; only their first column
   * is checked.
   */
  readonly indexes: readonly IndexTarget[];
};

/**
 * The same facts, read from `pg_policies`, `pg_class`, the table grants and
 * `pg_proc`.
 */
export type ActualRls = {
  readonly policies: readonly {
    readonly table: string;
    readonly name: string;
    readonly command: string;
    readonly permissive: boolean;
    readonly roles: readonly string[];
  }[];
  readonly rlsEnabled: Readonly<Record<string, boolean>>;
  readonly grants: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
  readonly helpers: Readonly<
    Record<
      string,
      { readonly securityDefiner: boolean; readonly emptySearchPath: boolean }
    >
  >;
  /** Per table, the first column of each of its plain-column indexes. */
  readonly leadingColumns: Readonly<Record<string, readonly string[]>>;
  /**
   * Per table, its columns; a target on a column the table lacks is not
   * checked.
   */
  readonly columns?: Readonly<Record<string, readonly string[]>>;
};

/** `posts` and `"app"."posts"` as `public.posts` and `app.posts`. */
export function normalizeTableName(table: string): string {
  const parts = table.split(".").map((part) => part.replaceAll('"', ""));
  return parts.length === 1 ? `public.${parts[0] ?? ""}` : parts.join(".");
}

const FUNCTION_HEADER =
  /create or replace function ("?)([A-Za-z_][\w$]*)\1\.("?)([A-Za-z_][\w$]*)\3\s*\(([\s\S]*?)\nas \$/gu;

const TYPE_ALIASES: Readonly<Record<string, string>> = {
  int: "integer",
  int4: "integer",
  int2: "smallint",
  int8: "bigint",
  bool: "boolean",
  varchar: "character varying",
  char: "character",
  float4: "real",
  float8: "double precision",
  timestamp: "timestamp without time zone",
  timestamptz: "timestamp with time zone",
  time: "time without time zone",
  timetz: "time with time zone",
};

/**
 * A parameter type as `oidvectortypes` prints it: lower case, no quotes, no
 * schema, no type modifier, aliases spelled out. A `%type` reference is `*`,
 * which matches any type.
 */
function normalizeParameterType(type: string): string {
  const text = type.trim().toLowerCase().replaceAll('"', "");
  if (text.endsWith("%type")) {
    return "*";
  }
  const array = /(?:\[\d*\])+$/u.exec(text)?.[0] ?? "";
  const base = text
    .slice(0, text.length - array.length)
    .replaceAll(/\([^)]*\)/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  const unqualified = /^[\w$]+(?:\.[\w$]+)+$/u.test(base)
    ? (base.split(".").at(-1) ?? base)
    : base;
  return `${TYPE_ALIASES[unqualified] ?? unqualified}${"[]".repeat(array.split("[").length - 1)}`;
}

function splitTopLevel(text: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'") {
      quoted = !quoted;
    } else if (!quoted && char === "(") {
      depth += 1;
    } else if (!quoted && char === ")") {
      depth -= 1;
    } else if (!quoted && depth === 0 && char === ",") {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * The input parameter types of a function header that starts after its opening
 * parenthesis. Every generated parameter is named, so the first word of a
 * parameter with more than one is its name.
 */
function parameterTypes(header: string): readonly string[] {
  let depth = 0;
  let end = header.length;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      if (depth === 0) {
        end = index;
        break;
      }
      depth -= 1;
    }
  }
  return splitTopLevel(header.slice(0, end)).flatMap((parameter) => {
    const plain = parameter.replace(/\s+(?:default\b|=)[\s\S]*$/iu, "");
    const words = plain.split(/\s+/u);
    const mode = words[0]?.toLowerCase();
    if (mode === "out") {
      return [];
    }
    const rest =
      mode === "in" || mode === "inout" || mode === "variadic"
        ? words.slice(1)
        : words;
    return [
      normalizeParameterType(
        (rest.length > 1 ? rest.slice(1) : rest).join(" "),
      ),
    ];
  });
}

/** `schema.name(type, type)`, the key a helper is checked by. */
function signatureOf(name: string, types: readonly string[]): string {
  return `${name}(${types.join(", ")})`;
}

function helpersOf(sql: string): readonly string[] {
  const found = new Set<string>();
  for (const match of sql.matchAll(FUNCTION_HEADER)) {
    const [header = "", , schema = "", , name = "", rest = ""] = match;
    if (/\bsecurity definer\b/u.test(header)) {
      found.add(signatureOf(`${schema}.${name}`, parameterTypes(rest)));
    }
  }
  return [...found];
}

function nameOfSignature(signature: string): string {
  return signature.slice(0, signature.indexOf("("));
}

function typesOfSignature(signature: string): readonly string[] {
  return splitTopLevel(
    signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")")),
  ).map(normalizeParameterType);
}

/** The actual overload `expected` names; `*` matches any parameter type. */
function matchHelper(
  expected: string,
  actual: ActualRls["helpers"],
): ActualRls["helpers"][string] | undefined {
  if (Object.hasOwn(actual, expected)) {
    return actual[expected];
  }
  const name = nameOfSignature(expected);
  const want = typesOfSignature(expected);
  for (const [signature, helper] of Object.entries(actual)) {
    const have = typesOfSignature(signature);
    if (
      nameOfSignature(signature) === name &&
      have.length === want.length &&
      want.every((type, index) => type === "*" || type === have[index])
    ) {
      return helper;
    }
  }
  return undefined;
}

export function expectedRls(
  policies: readonly CompiledPolicy[],
  sql: string,
  indexes: readonly IndexTarget[] = [],
): ExpectedRls {
  const tables = [
    ...new Set(policies.map((item) => normalizeTableName(item.table))),
  ];
  const grants: Record<string, Record<string, Privilege[]>> = {};
  for (const table of tables) {
    const byRole: Record<string, Privilege[]> = {};
    for (const role of ROLES) {
      const commands = new Set(
        policies
          .filter(
            (item) =>
              normalizeTableName(item.table) === table &&
              item.effect === "allow" &&
              item.roles.includes(role),
          )
          .map((item) => item.command),
      );
      byRole[role] = PRIVILEGES.filter((privilege) => commands.has(privilege));
    }
    grants[table] = byRole;
  }
  return {
    policies: policies.map((item) => ({
      table: normalizeTableName(item.table),
      name: item.name,
      command: item.command,
      permissive: item.effect === "allow",
      roles: item.roles.toSorted(),
    })),
    tables,
    grants,
    helpers: helpersOf(sql),
    indexes: indexes.map((target) => ({
      ...target,
      table: normalizeTableName(target.table),
    })),
  };
}

/**
 * One warning per index target no index starts with. A missing index slows the
 * policy down but grants nothing, so these do not fail `verify`.
 */
export function missingIndexes(
  expected: ExpectedRls,
  actual: ActualRls,
): readonly RlsFinding[] {
  return expected.indexes.flatMap((target) => {
    const column = target.columns[0];
    const columns = actual.columns?.[target.table];
    return column === undefined ||
      (columns !== undefined && !columns.includes(column)) ||
      actual.leadingColumns[target.table]?.includes(column) === true
      ? []
      : [
          rlsFinding(
            "index-missing",
            target.table,
            column,
            `${target.table}: no index starts with ${column}, which the policies or helpers filter on; add it, or write it with rls generate --split ...,indexes`,
            "warning",
          ),
        ];
  });
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  const a = left.toSorted();
  const b = right.toSorted();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * One finding per difference; policy expressions are not compared, since
 * Postgres rewrites their text.
 */
export function diffRls(
  expected: ExpectedRls,
  actual: ActualRls,
  options: { readonly columnGrants?: boolean } = {},
): readonly RlsFinding[] {
  const out: RlsFinding[] = [];
  const found = new Map(
    actual.policies.map((item) => [`${item.table}\u0000${item.name}`, item]),
  );
  for (const want of expected.policies) {
    const have = found.get(`${want.table}\u0000${want.name}`);
    if (have === undefined) {
      out.push(
        rlsFinding(
          "policy-missing",
          want.table,
          want.name,
          `${want.table}: policy ${want.name} is missing`,
        ),
      );
      continue;
    }
    if (have.command !== want.command) {
      out.push(
        rlsFinding(
          "policy-command",
          want.table,
          want.name,
          `${want.table}: policy ${want.name} is for ${have.command}, expected ${want.command}`,
        ),
      );
    }
    if (have.permissive !== want.permissive) {
      out.push(
        rlsFinding(
          "policy-mode",
          want.table,
          want.name,
          `${want.table}: policy ${want.name} is ${have.permissive ? "permissive" : "restrictive"}, expected ${want.permissive ? "permissive" : "restrictive"}`,
        ),
      );
    }
    if (!sameList(have.roles, want.roles)) {
      out.push(
        rlsFinding(
          "policy-roles",
          want.table,
          want.name,
          `${want.table}: policy ${want.name} applies to ${have.roles.join(", ")}, expected ${want.roles.join(", ")}`,
        ),
      );
    }
  }
  const wanted = new Set(
    expected.policies.map((item) => `${item.table}\u0000${item.name}`),
  );
  for (const have of actual.policies) {
    if (
      expected.tables.includes(have.table) &&
      !wanted.has(`${have.table}\u0000${have.name}`)
    ) {
      out.push(
        rlsFinding(
          "policy-extra",
          have.table,
          have.name,
          `${have.table}: policy ${have.name} is not generated (${have.permissive ? "permissive" : "restrictive"} ${have.command}); a permissive one widens access`,
        ),
      );
    }
  }
  for (const table of expected.tables) {
    if (actual.rlsEnabled[table] !== true) {
      out.push(
        actual.rlsEnabled[table] === undefined
          ? rlsFinding(
              "table-missing",
              table,
              "table",
              `${table}: table is missing`,
            )
          : rlsFinding(
              "rls-disabled",
              table,
              "table",
              `${table}: row level security is disabled`,
            ),
      );
      continue;
    }
    for (const role of ROLES) {
      const want = expected.grants[table]?.[role] ?? [];
      const have = actual.grants[table]?.[role] ?? [];
      for (const privilege of want) {
        if (
          !have.includes(privilege) &&
          !(privilege === "select" && options.columnGrants === true)
        ) {
          out.push(
            rlsFinding(
              "grant-missing",
              table,
              `${role}.${privilege}`,
              `${table}: ${role} lacks ${privilege}, so the policy answers 42501 instead of filtering`,
            ),
          );
        }
      }
      for (const privilege of have) {
        // SAFETY: widening the privilege union to string only lets includes() accept a catalog value.
        if (!(want as readonly string[]).includes(privilege)) {
          out.push(
            rlsFinding(
              "grant-extra",
              table,
              `${role}.${privilege}`,
              `${table}: ${role} holds ${privilege}, which no generated policy allows`,
            ),
          );
        }
      }
    }
  }
  for (const helper of expected.helpers) {
    const have = matchHelper(helper, actual.helpers);
    if (have === undefined) {
      out.push(
        rlsFinding(
          "helper-missing",
          helper,
          "helper",
          `${helper}: helper is missing`,
        ),
      );
      continue;
    }
    if (!have.securityDefiner) {
      out.push(
        rlsFinding(
          "helper-definer",
          helper,
          "helper",
          `${helper}: helper is not security definer`,
        ),
      );
    }
    if (!have.emptySearchPath) {
      out.push(
        rlsFinding(
          "helper-search-path",
          helper,
          "helper",
          `${helper}: helper does not set search_path = ''`,
        ),
      );
    }
  }
  return out;
}

const POLICIES_SQL = `select schemaname || '.' || tablename as target, policyname, cmd, permissive, roles::text[] as roles
from pg_policies
where schemaname || '.' || tablename = any($1::text[])`;

const TABLES_SQL = `select n.nspname || '.' || c.relname as target, c.relrowsecurity as enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and n.nspname || '.' || c.relname = any($1::text[])`;

const GRANTS_SQL = `select table_schema || '.' || table_name as target, grantee, lower(privilege_type) as privilege
from information_schema.role_table_grants
where grantee in ('anon', 'anonymous', 'authenticated')
  and lower(privilege_type) in ('select', 'insert', 'update', 'delete')
  and table_schema || '.' || table_name = any($1::text[])`;

const HELPERS_SQL = `select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as target, p.prosecdef as definer,
  coalesce(array_to_string(p.proconfig, ','), '') as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname || '.' || p.proname = any($1::text[])`;

function commandOf(cmd: unknown): string {
  const text = typeof cmd === "string" ? cmd.toLowerCase() : "";
  return text === "*" ? "all" : text;
}

function connectIntrospect(db: string): Promise<SqlClient> {
  return connectPgPool(db, "permdock rls verify --introspect");
}

/**
 * Reads the catalogs for the tables and helpers `expected` names
 * (postgres-meta's queries, trimmed).
 */
export async function introspectRls(
  db: string,
  expected: ExpectedRls,
  connect: SqlConnect = connectIntrospect,
): Promise<ActualRls> {
  const client = await connect(db);
  try {
    const tables = [...expected.tables];
    const indexed = [
      ...new Set(expected.indexes.map((target) => target.table)),
    ];
    const [policies, enabled, grants, helpers, indexes, columns] =
      await Promise.all([
        client.query(POLICIES_SQL, [tables]),
        client.query(TABLES_SQL, [tables]),
        client.query(GRANTS_SQL, [tables]),
        client.query(HELPERS_SQL, [
          [...new Set(expected.helpers.map(nameOfSignature))],
        ]),
        client.query(INDEX_COLUMNS_SQL, [indexed]),
        client.query(COLUMNS_SQL, [indexed]),
      ]);
    const columnsOf: Record<string, string[]> = {};
    for (const row of columns.rows) {
      (columnsOf[String(row["target"])] ??= []).push(String(row["name"]));
    }
    const leadingColumns: Record<string, string[]> = {};
    for (const row of indexes.rows) {
      const keyColumns = Array.isArray(row["columns"]) ? row["columns"] : [];
      const lead = keyColumns.at(0);
      if (typeof lead === "string") {
        (leadingColumns[String(row["target"])] ??= []).push(lead);
      }
    }
    const byTable: Record<string, Record<string, string[]>> = {};
    for (const row of grants.rows) {
      const table = String(row["target"]);
      const role = liveRole(String(row["grantee"]));
      const entry = (byTable[table] ??= {});
      (entry[role] ??= []).push(String(row["privilege"]));
    }
    return {
      policies: policies.rows.map((row) => ({
        table: String(row["target"]),
        name: String(row["policyname"]),
        command: commandOf(row["cmd"]),
        permissive: String(row["permissive"]).toUpperCase() === "PERMISSIVE",
        roles: Array.isArray(row["roles"])
          ? row["roles"].map((role) => liveRole(String(role)))
          : [],
      })),
      rlsEnabled: Object.fromEntries(
        enabled.rows.map((row) => [
          String(row["target"]),
          row["enabled"] === true,
        ]),
      ),
      grants: byTable,
      helpers: Object.fromEntries(
        helpers.rows.map((row) => [
          signatureOf(
            nameOfSignature(String(row["target"])),
            typesOfSignature(String(row["target"])),
          ),
          {
            securityDefiner: row["definer"] === true,
            emptySearchPath: String(row["config"])
              .split(",")
              .some(
                (item) =>
                  item === 'search_path=""' || item === "search_path=''",
              ),
          },
        ]),
      ),
      leadingColumns,
      columns: columnsOf,
    };
  } finally {
    await client.end();
  }
}

/**
 * A helpers-only setup: the seeds `generate` would write and the keys
 * hand-written policies may pass.
 */
export type ExpectedMixed = {
  readonly schema: string;
  readonly seeds: readonly RolePermission[];
  readonly permissions: readonly string[];
  readonly rowConditions: readonly string[];
  /** Declared `<permission>@<level>` keys a custom role may hold. */
  readonly levels?: readonly LevelKey[];
  /**
   * `rls.readOnlyActors` is set: every write a client role reaches calls
   * `permdock_actor_may_write()`.
   */
  readonly readOnlyActors?: boolean;
};

/** Every policy and RLS table outside the system schemas, and the seeded rows. */
export type ActualMixed = {
  readonly seeds: readonly RolePermission[];
  readonly policies: readonly {
    readonly table: string;
    readonly name: string;
    readonly expression: string;
    /**
     * `pg_policies.cmd` in lower case: `select`, `insert`, `update`, `delete`
     * or `all`.
     */
    readonly command?: string;
    readonly restrictive?: boolean;
    readonly roles?: readonly string[];
  }[];
  readonly rlsTables: readonly string[];
};

const WRITES = ["insert", "update", "delete"] as const;

/**
 * Each table and write command whose permissive policies reach `authenticated`
 * (or `public`) without the read-only actor check: no restrictive policy for
 * the command calls `permdock_actor_may_write()`, and some permissive one does
 * not.
 */
function unguardedWrites(
  policies: ActualMixed["policies"],
  fn: string,
): readonly RlsFinding[] {
  const out: RlsFinding[] = [];
  const tables = [...new Set(policies.map((policy) => policy.table))];
  for (const table of tables) {
    for (const command of WRITES) {
      const applying = policies.filter(
        (policy) =>
          policy.table === table &&
          (policy.command === command || policy.command === "all"),
      );
      const permissive = applying.filter(
        (policy) =>
          policy.restrictive !== true &&
          (policy.roles ?? []).some(
            (role) => role === "authenticated" || role === "public",
          ),
      );
      if (permissive.length === 0) {
        continue;
      }
      const calls = (expression: string): boolean => expression.includes(fn);
      const guarded =
        applying.some(
          (policy) => policy.restrictive === true && calls(policy.expression),
        ) || permissive.every((policy) => calls(policy.expression));
      if (!guarded) {
        out.push(
          rlsFinding(
            "write-unguarded",
            table,
            command,
            `${table}: ${command} policies for authenticated do not call ${fn}(), so a read-only support or impersonation session can write (rls.readOnlyActors)`,
          ),
        );
      }
    }
  }
  return out;
}

const SYSTEM_SCHEMAS = [
  "pg_catalog",
  "information_schema",
  "pg_toast",
  "auth",
  "storage",
  "realtime",
  "extensions",
  "graphql",
  "graphql_public",
  "vault",
  "pgsodium",
  "pgsodium_masks",
  "net",
  "cron",
  "supabase_functions",
  "supabase_migrations",
] as const;

function inScope(table: string): boolean {
  const schema = beforeFirst(table, ".");
  return (
    HELPER_TABLES.some((item) => item === table) ||
    !(
      SYSTEM_SCHEMAS.some((item) => item === schema) || schema.startsWith("pg_")
    )
  );
}

function seedLine(row: RolePermission): string {
  return `${row.role} ${row.effect} ${row.grantKey} on ${row.scope}`;
}

function seedKey(line: string): string {
  return line.replace(" on ", " ").replaceAll(" ", "/");
}

/**
 * Drift is an error; `info` names RLS tables whose policies call no PermDock
 * helper.
 */
export function diffMixed(
  expected: ExpectedMixed,
  actual: ActualMixed,
): {
  readonly drift: readonly RlsFinding[];
  readonly info: readonly RlsFinding[];
} {
  const drift: RlsFinding[] = [];
  const seeds = `${expected.schema}.role_permissions`;
  const want = new Set(expected.seeds.map(seedLine));
  const have = new Set(actual.seeds.map(seedLine));
  for (const line of want) {
    if (!have.has(line)) {
      drift.push(
        rlsFinding(
          "seed-missing",
          seeds,
          seedKey(line),
          `${seeds}: missing ${line}`,
        ),
      );
    }
  }
  for (const line of have) {
    if (!want.has(line)) {
      drift.push(
        rlsFinding(
          "seed-extra",
          seeds,
          seedKey(line),
          `${seeds}: unexpected ${line}`,
        ),
      );
    }
  }
  const permissions = new Set(expected.permissions);
  const conditioned = new Set(expected.rowConditions);
  const levels = new Map(
    (expected.levels ?? []).map((level) => [level.key, level]),
  );
  const notes: RlsFinding[] = [];
  const covered = new Set<string>();
  for (const policy of actual.policies) {
    if (callsHelper(policy.expression)) {
      covered.add(policy.table);
    }
    const blind = new Set(helperCallKeys(policy.expression, true));
    for (const key of helperCallKeys(policy.expression)) {
      const level = levels.get(key);
      if (level !== undefined) {
        if (level.conditioned) {
          notes.push(
            rlsFinding(
              "level-unconditioned",
              policy.table,
              `${policy.name}/${key}`,
              `${policy.table}: policy ${policy.name} passes ${key}, which skips the level's row condition, so holders of it are denied there; use ${level.rowHelper}(${policy.table.slice(policy.table.lastIndexOf(".") + 1)}, '${level.permission}')`,
              "info",
            ),
          );
        }
      } else if (!permissions.has(key)) {
        drift.push(
          rlsFinding(
            "undeclared-key",
            policy.table,
            `${policy.name}/${key}`,
            `${policy.table}: policy ${policy.name} passes ${key}, which the policy does not declare, so it always denies`,
          ),
        );
      } else if (conditioned.has(key) && blind.has(key)) {
        drift.push(
          rlsFinding(
            "condition-blind",
            policy.table,
            `${policy.name}/${key}`,
            `${policy.table}: policy ${policy.name} passes ${key}, whose grants carry row conditions the helpers do not check: the policy grants more than the application does`,
          ),
        );
      }
    }
  }
  if (expected.readOnlyActors === true) {
    drift.push(...unguardedWrites(actual.policies, ACTOR_MAY_WRITE));
  }
  const info = [
    ...notes,
    ...actual.rlsTables
      .filter((table) => !covered.has(table))
      .map((table) =>
        rlsFinding(
          "helper-uncalled",
          table,
          "table",
          `${table}: no policy calls a PermDock helper`,
          "info",
        ),
      ),
  ];
  return { drift, info };
}

const ALL_POLICIES_SQL = `select schemaname || '.' || tablename as target, policyname,
  coalesce(qual, '') || ' ' || coalesce(with_check, '') as expression,
  lower(cmd) as command, permissive = 'RESTRICTIVE' as restrictive,
  array_to_string(roles, ',') as roles
from pg_policies`;

const RLS_TABLES_SQL = `select n.nspname || '.' || c.relname as target
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and c.relrowsecurity`;

const quoteIdent = escapeSqlIdent;

/**
 * Reads `role_permissions`, `pg_policies` and the RLS-enabled tables for
 * {@link diffMixed}.
 */
export async function introspectMixed(
  db: string,
  schema: string,
  connect: SqlConnect = connectIntrospect,
): Promise<ActualMixed> {
  const client = await connect(db);
  try {
    const [seeds, policies, tables] = await Promise.all([
      client.query(
        `select role, permission, grant_key, scope, effect from ${quoteIdent(schema)}.role_permissions`,
        [],
      ),
      client.query(ALL_POLICIES_SQL, []),
      client.query(RLS_TABLES_SQL, []),
    ]);
    return {
      seeds: seeds.rows.map((row) => ({
        role: String(row["role"]),
        permission: String(row["permission"]),
        grantKey: String(row["grant_key"]),
        scope: String(row["scope"]),
        effect: String(row["effect"]) === "deny" ? "deny" : "allow",
      })),
      policies: policies.rows
        .map((row) => ({
          table: String(row["target"]),
          name: String(row["policyname"]),
          expression: String(row["expression"]),
          command: String(row["command"]),
          restrictive: row["restrictive"] === true,
          roles: (typeof row["roles"] === "string" ? row["roles"] : "")
            .split(",")
            .filter((role) => role !== ""),
        }))
        .filter((row) => inScope(row.table)),
      rlsTables: tables.rows
        .map((row) => String(row["target"]))
        .filter(inScope)
        .toSorted(),
    };
  } finally {
    await client.end();
  }
}
