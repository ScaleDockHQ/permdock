import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deparse } from "pgsql-parser";

import type { CommandResult } from "../core/result.ts";
import type { SqlConnect } from "../pg.ts";
import type { CliIo, PermDockConfig } from "../types.ts";
import type { RolePermission } from "./helpers.ts";
import type { ImportedGrant } from "./import-ast.ts";
import type { ImportedFieldView } from "./import-views.ts";

import { configError, usageResult } from "../core/errors.ts";
import { writeFileEnsuringDir } from "../files.ts";
import {
  emitPermissionsModule,
  emptySchema,
  isSchemaKind,
} from "../generate.ts";
import { pgConnector } from "../pg.ts";
import { SqlSyntaxError, parseSqlFile, readPolicy } from "../sql/ast.ts";
import { parseMembershipsFlag } from "../sql/context.ts";
import { conditionFromAst, helperGrants } from "./import-ast.ts";
import { mapRoleValues } from "./import-membership.ts";
import { fingerprintSql } from "./import-nodes.ts";
import { seedFromRow, seedsFromSql } from "./import-seeds.ts";
import { fieldViewsFromSql, viewsSqlFromDb } from "./import-views.ts";

type ImportedPolicy = {
  readonly table: string;
  readonly cmd: string;
  readonly name: string;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly using?: string;
  readonly check?: string;
};

type CatalogEntry = {
  readonly table: string;
  readonly cmd: string;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly condition: unknown;
  readonly fingerprint: string;
  readonly sourceSql: string;
  /**
   * Role-gated branches read back from RLS helper calls and the
   * `role_permissions` seeds.
   */
  readonly grants?: readonly ImportedGrant[];
};

async function deparseExpr(expr: unknown): Promise<string | undefined> {
  if (expr === undefined) {
    return undefined;
  }
  // SAFETY: readPolicy takes expr from pgsql-parser's own parse tree, which deparse accepts.
  const text = await deparse(expr as Parameters<typeof deparse>[0]);
  return text;
}

/** The `create policy` statements of a SQL dump, one per command they name. */
async function splitPolicies(sql: string): Promise<ImportedPolicy[]> {
  const out: ImportedPolicy[] = [];
  for (const node of await parseSqlFile(sql)) {
    const policy = readPolicy(node);
    if (policy === undefined) {
      continue;
    }
    const using = await deparseExpr(policy.using);
    const check = await deparseExpr(policy.check);
    const commands =
      policy.command === "all"
        ? ["SELECT", "INSERT", "UPDATE", "DELETE"]
        : [policy.command.toUpperCase()];
    for (const command of commands) {
      out.push({
        name: policy.name,
        table: policy.table,
        cmd: command,
        permissive: policy.permissive,
        roles: policy.roles,
        ...(using === undefined ? {} : { using }),
        ...(check === undefined ? {} : { check }),
      });
    }
  }
  return out;
}

function actionsFor(cmds: readonly string[]): {
  readonly actions: readonly string[];
  readonly collection: readonly string[];
} {
  const actions: string[] = [];
  const collection: string[] = [];
  if (cmds.includes("SELECT")) {
    actions.push("read");
    collection.push("list");
  }
  if (cmds.includes("INSERT")) {
    collection.push("create");
  }
  if (cmds.includes("UPDATE")) {
    actions.push("update");
  }
  if (cmds.includes("DELETE")) {
    actions.push("delete");
  }
  if (actions.length === 0) {
    actions.push("read");
  }
  return { actions, collection };
}

function emitGenerated(
  catalog: readonly CatalogEntry[],
  fieldViews: readonly ImportedFieldView[],
  schema: string,
): string {
  const kind = isSchemaKind(schema) ? schema : "zod";
  const tables = [...new Set(catalog.map((item) => item.table))];
  return emitPermissionsModule({
    generator: "rls import",
    schema: kind,
    exports: fieldViews.length === 0 ? { catalog } : { catalog, fieldViews },
    resources: tables.map((table) => {
      const { actions, collection } = actionsFor(
        catalog.filter((item) => item.table === table).map((item) => item.cmd),
      );
      return {
        path: [table.replaceAll(/[^A-Za-z0-9_]/gu, "_")],
        schema: emptySchema(kind),
        actions,
        collection,
      };
    }),
  });
}

function assertNoServiceRole(sql: string): void {
  if (/\bto\s+service_role\b|\bfrom\s+service_role\b/iu.test(sql)) {
    throw configError(
      "PermDock CLI: imported SQL must never target service_role",
    );
  }
}

type Query = (
  sql: string,
) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;

async function seedsFromDb(query: Query): Promise<readonly RolePermission[]> {
  const tables = await query(
    `select table_schema from information_schema.tables where table_name = 'role_permissions' order by table_schema = 'permdock' desc, table_schema = 'public' desc, table_schema limit 1`,
  );
  const schema = tables.rows[0]?.["table_schema"];
  if (typeof schema !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) {
    return [];
  }
  try {
    const rows = await query(
      `select role::text, permission::text, grant_key, scope, effect from "${schema}".role_permissions`,
    );
    return rows.rows.flatMap((row) => {
      const seed = seedFromRow(row);
      return seed === undefined ? [] : [seed];
    });
  } catch {
    // A pre-helper `role_permissions` (no grant_key) has nothing to map.
    return [];
  }
}

/**
 * `pg_policies.roles` is a `name[]`, which `pg` returns as an array or,
 * untyped, as `{a,b}`.
 */
function policyRoles(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  return typeof value === "string"
    ? value
        .replaceAll(/[{}]/gu, "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "")
    : [];
}

async function policiesFromDb(
  db: string,
  connect: SqlConnect,
): Promise<{
  readonly policies: ImportedPolicy[];
  readonly bodies: Map<string, string>;
  readonly seeds: readonly RolePermission[];
  readonly views: string;
}> {
  const client = await connect(db);
  const query: Query = (sql) => client.query(sql, []);
  try {
    const result = await query(
      `select tablename, policyname, permissive, roles, cmd, qual, with_check from pg_policies`,
    );
    const bodies = new Map<string, string>();
    const procs = await query(`select proname, prosrc from pg_proc`);
    for (const row of procs.rows) {
      const { proname, prosrc } = row;
      if (typeof proname === "string" && typeof prosrc === "string") {
        bodies.set(proname, prosrc);
      }
    }
    const seeds = await seedsFromDb(query);
    const views = await viewsSqlFromDb(query);
    const policies: ImportedPolicy[] = [];
    for (const row of result.rows) {
      const { tablename, policyname, qual, with_check: check } = row;
      if (typeof tablename !== "string" || typeof policyname !== "string") {
        continue;
      }
      const cmd =
        typeof row["cmd"] === "string" ? row["cmd"].toUpperCase() : "ALL";
      const commands =
        cmd === "ALL" ? ["SELECT", "INSERT", "UPDATE", "DELETE"] : [cmd];
      for (const command of commands) {
        policies.push({
          name: policyname,
          table: tablename,
          cmd: command,
          permissive: row["permissive"] !== "RESTRICTIVE",
          roles: policyRoles(row["roles"]),
          ...(typeof qual === "string" ? { using: qual } : {}),
          ...(typeof check === "string" ? { check } : {}),
        });
      }
    }
    return { policies, bodies, seeds, views };
  } finally {
    await client.end();
  }
}

export async function runRlsImport(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly sql?: string;
  readonly db?: string;
  readonly out?: string;
  readonly schema: string;
  readonly memberships?: string;
  readonly io: CliIo;
  /** Opens the `--db-url-stdin` connection; defaults to the `pg` peer. */
  readonly connect?: SqlConnect;
}): Promise<CommandResult> {
  let policies: ImportedPolicy[] = [];
  let bodies = new Map<string, string>();
  let seeds: readonly RolePermission[] = [];
  let viewsSql = "";
  if (input.sql !== undefined) {
    const sqlPath = resolve(input.cwd, input.sql);
    if (!existsSync(sqlPath)) {
      return {
        code: 2,
        output: `PermDock CLI: SQL dump not found: ${input.sql}`,
      };
    }
    const sql = readFileSync(sqlPath, "utf8");
    assertNoServiceRole(sql);
    viewsSql = sql;
    seeds = await seedsFromSql(sql);
    try {
      policies = await splitPolicies(sql);
    } catch (error) {
      if (error instanceof SqlSyntaxError) {
        return {
          code: 2,
          output: `PermDock CLI: ${input.sql}: ${error.message}; rls import reads SQL with the Postgres 18 grammar`,
        };
      }
      throw error;
    }
  } else if (input.db === undefined) {
    return {
      code: 2,
      output:
        "PermDock CLI: rls import needs --sql <file> or a database: --db-url-stdin, DATABASE_URL or SUPABASE_DB_URL",
    };
  } else {
    try {
      const fromDb = await policiesFromDb(
        input.db,
        input.connect ??
          pgConnector("permdock rls import --db-url-stdin", input.cwd),
      );
      policies = fromDb.policies;
      bodies = fromDb.bodies;
      seeds = fromDb.seeds;
      viewsSql = fromDb.views;
    } catch (cause) {
      return usageResult(cause);
    }
  }
  const memberships =
    parseMembershipsFlag(input.memberships) ?? input.config.rls?.memberships;
  const roleValues = input.config.rls?.roleValues;
  if (roleValues !== undefined) {
    seeds = seeds.map((row) => {
      const mapped = Object.hasOwn(roleValues, row.role)
        ? roleValues[row.role]
        : undefined;
      return mapped === undefined ? row : { ...row, role: mapped };
    });
  }
  const functions = input.config.rls?.functions;
  const unmapped: string[] = [];
  const joins: string[] = [];
  const catalog: CatalogEntry[] = [];
  for (const item of policies) {
    const sourceSql = item.using ?? item.check ?? "true";
    const condition = mapRoleValues(
      await conditionFromAst(
        item.using ?? item.check,
        memberships,
        functions,
        unmapped,
        joins,
        seeds,
      ),
      input.config.rls?.roleValues,
    );
    const grants = await helperGrants(
      item.using ?? item.check,
      memberships,
      functions,
      seeds,
    );
    catalog.push({
      table: item.table,
      cmd: item.cmd,
      permissive: item.permissive,
      roles: item.roles,
      condition,
      fingerprint: await fingerprintSql(sourceSql),
      sourceSql,
      ...(grants.length === 0 ? {} : { grants }),
    });
  }
  const fieldViews =
    viewsSql === ""
      ? []
      : await fieldViewsFromSql(viewsSql, memberships, functions, seeds);
  const outRel = input.out ?? "src/permissions.generated.ts";
  const outPath = resolve(input.cwd, outRel);
  writeFileEnsuringDir(
    outPath,
    emitGenerated(catalog, fieldViews, input.schema),
  );
  const unique = [...new Set(unmapped)];
  const hints = [
    ...uniqueHints(unique, bodies),
    ...[...new Set(joins)].map(membershipHint),
    ...fieldViews.map(fieldViewHint),
  ];
  return {
    code: 0,
    output:
      hints.length === 0
        ? `wrote ${outRel}`
        : `wrote ${outRel}\n${hints.join("\n")}`,
  };
}

function fieldViewHint(view: ImportedFieldView): string {
  return `field view ${view.view} over ${view.table}: ${view.restricted.map((item) => item.column).join(", ")} are field-limited; set fields on the read grants that list them (fieldViews export)`;
}

function membershipHint(table: string): string {
  return [
    `exists over ${table} stayed opaque; if it holds memberships, map it in permdock.config.ts:`,
    `// rls: { memberships: { scopes: { tenant: { table: '${table}', user: 'user_id', columns: { tenant: 'tenant_id' }, role: 'role' } } } }`,
  ].join("\n");
}

function uniqueHints(
  names: readonly string[],
  bodies: ReadonlyMap<string, string>,
): readonly string[] {
  const lines: string[] = [];
  for (const name of names) {
    const short = name.includes(".")
      ? name.slice(name.lastIndexOf(".") + 1)
      : name;
    lines.push(`add rls.functions.${short} to make this grant portable`);
    const body = bodies.get(short) ?? bodies.get(name);
    if (body !== undefined) {
      lines.push(`-- ${name}: ${body.trim().slice(0, 240)}`);
    }
  }
  return lines;
}
