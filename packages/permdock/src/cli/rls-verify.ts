import { resolve } from "node:path";

import type { Scope } from "../core/scopes.ts";
import type { CustomRole, PermDock, Permission, Policy } from "../index.ts";
import type { CliIo, PermDockConfig, RlsDialect } from "./types.ts";

import { customRoleScope, membershipsClaim } from "../core/custom-roles.ts";
import { scopeList } from "../core/scopes.ts";
import {
  createPermDock,
  findPermission,
  hasConditionOp,
  memoryRoleSource,
} from "../index.ts";
import { supabaseTenantClaim } from "../supabase/budget.ts";
import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";
import { policyRowConditionKeys } from "./catalog-doc.ts";
import { usageResult } from "./errors.ts";
import {
  type RlsFixture,
  fixtureRow,
  fixtureSubject,
  loadFixtures,
} from "./fixtures.ts";
import {
  HELPER_TABLE_POLICIES_SQL,
  helperTablePoliciesFromRows,
  rowConditionMessage,
} from "./helper-calls.ts";
import { asPolicy, loadModule, pickNamed } from "./load.ts";
import { connectPg, type SqlConnect } from "./pg.ts";
import { commandFor } from "./rls-compile.ts";
import { FIELD_VIEWS, viewName } from "./rls-fields.ts";
import { quoteIdent } from "./rls-sql.ts";
import { verifyTree } from "./rls-verify-tree.ts";

export type VerifyOutcome = {
  readonly code: 0 | 1 | 2;
  readonly output: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A custom role's scope and pinned instance, as the `custom_role_*` tables store them. */
function customRoleAt(
  role: CustomRole,
  scopes: readonly Scope[],
): { readonly scope: string | undefined; readonly id: string | undefined } {
  return {
    scope: customRoleScope(role, scopes),
    id: role.scope === undefined ? role.team : role.id,
  };
}

function canFixture(
  permdock: PermDock,
  permission: Permission,
  row: unknown,
): boolean {
  if (permission.kind === "collection") {
    // SAFETY: kind was checked on the line above; Permission's kind parameter does not narrow.
    return permdock.can(
      permission as Permission<string, unknown, "collection">,
      row,
    );
  }
  // SAFETY: a permission is collection or instance, and collection returned above.
  return permdock.can(
    permission as Permission<string, unknown, "instance">,
    row,
  );
}

function grantKind(
  policy: Policy,
  key: string,
): "opaque" | "sqlFunction" | "portable" {
  const grants = policy.grants.filter((grant) => grant.permission.key === key);
  if (
    grants.some(
      (grant) =>
        hasConditionOp(grant.where, "opaque") ||
        hasConditionOp(grant.check, "opaque"),
    )
  ) {
    return "opaque";
  }
  if (
    grants.some(
      (grant) =>
        hasConditionOp(grant.where, "sqlFunction") ||
        hasConditionOp(grant.check, "sqlFunction"),
    )
  ) {
    return "sqlFunction";
  }
  return "portable";
}

type Statement = { readonly sql: string; readonly values: readonly unknown[] };

function columnsOf(row: unknown): readonly (readonly [string, unknown])[] {
  return isRecord(row)
    ? Object.entries(row).filter(
        ([, value]) => value !== undefined && typeof value !== "object",
      )
    : [];
}

/**
 * The statement a fixture runs: `create` inserts the whole row, `update` writes
 * `newRow` when given. Each reads back only the key, so `--revoke-columns`
 * (which keeps only unrestricted columns readable) does not reject it.
 */
function statementFor(
  fixture: RlsFixture,
  action: string,
  table: string,
): Statement {
  const quoted = quoteIdent(table);
  const id = quoteIdent("id");
  const key = rowId(fixture.row);
  switch (action) {
    case "read":
    case "list":
    case "get":
      return {
        sql: `select ${id} from ${quoted} where ${id} = $1`,
        values: [key],
      };
    case "update": {
      const next = columnsOf(fixture.newRow).filter(([name]) => name !== "id");
      const sets =
        next.length === 0
          ? `${id} = ${id}`
          : next
              .map(([name], index) => `${quoteIdent(name)} = $${index + 2}`)
              .join(", ");
      return {
        sql: `update ${quoted} set ${sets} where ${id} = $1 returning ${id}`,
        values: [key, ...next.map(([, value]) => value)],
      };
    }
    case "create": {
      const cols = columnsOf(fixture.row);
      if (cols.length === 0) {
        return {
          sql: `insert into ${quoted} (${id}) values ($1) returning ${id}`,
          values: [key],
        };
      }
      return {
        sql: `insert into ${quoted} (${cols.map(([name]) => quoteIdent(name)).join(", ")}) values (${cols.map((_, index) => `$${index + 1}`).join(", ")}) returning ${id}`,
        values: cols.map(([, value]) => value),
      };
    }
    case "delete":
      return {
        sql: `delete from ${quoted} where ${id} = $1 returning ${id}`,
        values: [key],
      };
    default:
      return {
        sql: `select ${id} from ${quoted} where ${id} = $1`,
        values: [key],
      };
  }
}

function rowId(row: unknown): unknown {
  if (isRecord(row) && "id" in row) {
    return row["id"];
  }
  return undefined;
}

function emitPgtap(
  fixtures: readonly RlsFixture[],
  customRoles: readonly CustomRole[],
  scopes: readonly Scope[],
): string {
  const lines = [
    "begin;",
    `select plan(${fixtures.length});`,
    "-- fixtures carry memberships and tenant for the exists join",
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const claims = JSON.stringify({
      sub: fixture.subject.id,
      role: "authenticated",
      tenant_id: fixture.subject.tenant ?? null,
      memberships: membershipsClaim(
        fixture.subject.memberships ?? [],
        customRoles,
        scopes,
      ),
    });
    lines.push(
      `-- ${fixture.action}`,
      `select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true);`,
      `select set_config('request.jwt.claim.sub', ${JSON.stringify(fixture.subject.id)}, true);`,
      `select ok(true, 'fixture ${index} ${fixture.action}');`,
    );
  }
  lines.push("select * from finish();", "rollback;");
  return `${lines.join("\n")}\n`;
}

type InProcess = {
  readonly action: string;
  readonly granted: boolean;
  readonly kind: "opaque" | "sqlFunction" | "portable";
  /** With field views: the columns `pick` keeps that hold a value, plus the key. */
  readonly fields?: readonly string[];
};

/** Columns of `row` that hold a value; a masked column reads as null. */
function valuedColumns(row: unknown): readonly string[] {
  return isRecord(row)
    ? Object.keys(row)
        .filter((name) => row[name] !== null && row[name] !== undefined)
        .toSorted()
    : [];
}

/**
 * What a field view returns for a row: nothing for a denied row, otherwise
 * `pick`'s columns with a value plus the key, which always passes through.
 */
function expectedFields(
  granted: boolean,
  picked: unknown,
  key: string,
  row: unknown,
): readonly string[] {
  if (!granted) {
    return [];
  }
  const kept = new Set(valuedColumns(picked));
  if (isRecord(row) && row[key] !== null && row[key] !== undefined) {
    kept.add(key);
  }
  return [...kept].toSorted();
}

function fieldsMismatch(
  fixture: RlsFixture,
  want: readonly string[],
  seen: readonly string[] | string,
): readonly string[] {
  const kept = want.join(", ");
  if (typeof seen === "string") {
    return [
      `${fixture.action}: field view read failed (${seen}), pick keeps [${kept}]`,
    ];
  }
  return seen.join(", ") === kept
    ? []
    : [
        `${fixture.action} ${String(rowId(fixture.row))}: field view returns [${seen.join(", ")}], pick keeps [${kept}]`,
      ];
}

/** The field view's columns for the fixture's row: the view, or the table itself when no grant limits its fields. */
async function viewFields(
  query: QueryFn,
  table: string,
  key: unknown,
): Promise<readonly string[] | string> {
  const view = quoteIdent(viewName(table, FIELD_VIEWS.view));
  const id = quoteIdent("id");
  await query("savepoint permdock_fields");
  const result = await query(`select * from ${view} where ${id} = $1`, [key]);
  if (result.code === undefined) {
    return valuedColumns(result.rows[0]);
  }
  await query("rollback to savepoint permdock_fields");
  if (result.code !== "42P01") {
    return result.code;
  }
  const base = await query(
    `select * from ${quoteIdent(table)} where ${id} = $1`,
    [key],
  );
  return base.code ?? valuedColumns(base.rows[0]);
}

type QueryFn = (
  sql: string,
  values?: readonly unknown[],
) => Promise<{
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount?: number;
  readonly code?: string;
}>;

/** Writes the custom roles into the `database`-mode tables; the fixture transaction rolls them back. */
async function seedCustomRoles(
  query: QueryFn,
  schema: string,
  customRoles: readonly CustomRole[],
  scopes: readonly Scope[],
): Promise<void> {
  const table = (name: string): string =>
    `${quoteIdent(schema)}.${quoteIdent(name)}`;
  const write = async (
    sql: string,
    values: readonly unknown[],
  ): Promise<void> => {
    const result = await query(sql, values);
    if (result.code !== undefined) {
      throw new Error(
        `PermDock CLI: rls verify --db could not seed custom roles (${result.code}); connect as a role that owns the custom_role_* tables`,
      );
    }
  };
  for (const role of customRoles) {
    const at = customRoleAt(role, scopes);
    if (at.scope === undefined) {
      continue;
    }
    for (const grant of role.grants ?? []) {
      await write(
        `insert into ${table("custom_role_permissions")} (tenant_id, scope, scope_id, role, permission, effect) values ($1, $2, $3, $4, $5, $6)`,
        [
          role.tenant,
          at.scope,
          at.id ?? null,
          role.name,
          grant.permission,
          grant.effect ?? "allow",
        ],
      );
    }
    for (const name of role.includes ?? []) {
      await write(
        `insert into ${table("custom_role_includes")} (tenant_id, scope, scope_id, role, include_role) values ($1, $2, $3, $4, $5)`,
        [role.tenant, at.scope, at.id ?? null, role.name, name],
      );
    }
  }
}

async function bindSubject(
  query: QueryFn,
  fixture: RlsFixture,
  dialect: RlsDialect,
  gucPrefix: string,
  tenantClaim: string,
  roleClaim: string,
  customRoles: readonly CustomRole[],
  scopes: readonly Scope[],
): Promise<void> {
  await query('set local role "authenticated"');
  const roles = fixture.subject.roles ?? [];
  const memberships = membershipsClaim(
    fixture.subject.memberships ?? [],
    customRoles,
    scopes,
  );
  if (dialect === "guc") {
    const settings: [string, string][] = [
      [`${gucPrefix}.user_id`, fixture.subject.id],
      [`${gucPrefix}.${roleClaim}`, roles.join(",")],
      [`${gucPrefix}.memberships`, JSON.stringify(memberships)],
    ];
    if (fixture.subject.tenant !== undefined) {
      settings.push([`${gucPrefix}.${tenantClaim}`, fixture.subject.tenant]);
    }
    for (const [name, value] of settings) {
      await query("select set_config($1, $2, true)", [name, value]);
    }
    return;
  }
  const claims = {
    sub: fixture.subject.id,
    role: "authenticated",
    [roleClaim]: roles.length === 1 ? roles[0] : roles,
    [tenantClaim]: fixture.subject.tenant,
    memberships,
  };
  await query("select set_config($1, $2, true)", [
    "request.jwt.claims",
    JSON.stringify(claims),
  ]);
  await query("select set_config($1, $2, true)", [
    "request.jwt.claim.sub",
    fixture.subject.id,
  ]);
}

async function verifyAgainstDatabase(input: {
  readonly db: string;
  readonly policy: Policy;
  readonly fixtures: readonly RlsFixture[];
  readonly customRoles: readonly CustomRole[];
  readonly config: PermDockConfig;
  readonly inProcess: readonly InProcess[];
  readonly connect: SqlConnect;
}): Promise<{ readonly mismatches: string[]; readonly notes: string[] }> {
  const client = await input.connect(input.db);
  const dialect = input.config.rls?.dialect ?? "supabase";
  const gucPrefix = input.config.rls?.gucPrefix ?? "app";
  const tenantClaim = input.config.rls?.tenantClaim ?? supabaseTenantClaim;
  const roleClaim = input.config.rls?.roleClaim ?? "user_role";
  const rls = input.config.rls;
  const seedsTables =
    rls?.customRoles === true &&
    (rls.authorize ?? rls.rbac?.authorize ?? "jwt") === "database";
  const schema = rls?.schema ?? rls?.rbac?.schema ?? PERMDOCK_SCHEMA;
  const scopes = scopeList(input.policy.scopes);
  const query: QueryFn = async (sql, values) => {
    try {
      const result = await client.query(
        sql,
        values === undefined ? [] : [...values],
      );
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      };
    } catch (cause) {
      const code =
        cause !== null &&
        typeof cause === "object" &&
        "code" in cause &&
        typeof cause.code === "string"
          ? cause.code
          : undefined;
      return { rows: [], rowCount: 0, ...(code === undefined ? {} : { code }) };
    }
  };
  const mismatches: string[] = [];
  const notes: string[] = [];
  try {
    const conditioned = policyRowConditionKeys(input.policy);
    for (const found of helperTablePoliciesFromRows(
      (await query(HELPER_TABLE_POLICIES_SQL)).rows,
    )) {
      const keys = found.keys.filter((key) => conditioned.has(key));
      if (keys.length > 0) {
        mismatches.push(`PD037 ${rowConditionMessage(found, keys)}`);
      }
    }
    for (const [index, fixture] of input.fixtures.entries()) {
      const permission = findPermission(
        input.policy.permissions,
        fixture.action,
      );
      const status = input.inProcess[index];
      if (permission === undefined || status === undefined) {
        continue;
      }
      if (status.kind === "opaque") {
        notes.push(`${fixture.action}: opaque grant untestable app-side`);
        continue;
      }
      const table =
        input.config.rls?.tables?.[permission.resource] ?? permission.resource;
      await query("begin");
      try {
        if (seedsTables) {
          await seedCustomRoles(query, schema, input.customRoles, scopes);
        }
        await bindSubject(
          query,
          fixture,
          dialect,
          gucPrefix,
          tenantClaim,
          roleClaim,
          input.customRoles,
          scopes,
        );
        const statement = statementFor(fixture, permission.action, table);
        const result = await query(statement.sql, statement.values);
        const count = result.rowCount ?? result.rows.length;
        const database =
          result.code === "42501"
            ? "rejected"
            : count > 0
              ? "allowed"
              : "filtered";
        const ok = status.granted
          ? database === "allowed"
          : database === "filtered" || database === "rejected";
        if (!ok) {
          mismatches.push(
            `${fixture.action}: in-process ${status.granted ? "granted" : "denied"}, database ${database}`,
          );
        } else if (status.kind === "sqlFunction") {
          notes.push(`${fixture.action}: verified through twin`);
        }
        mismatches.push(
          ...(status.fields === undefined
            ? []
            : fieldsMismatch(
                fixture,
                status.fields,
                await viewFields(query, table, rowId(fixture.row)),
              )),
        );
      } finally {
        await query("rollback");
      }
    }
  } finally {
    await client.end();
  }
  return { mismatches, notes };
}

/** `--tree`: seeds a generated object graph in a rolled-back transaction and compares `can()` with RLS. */
async function verifyTreeAgainstDatabase(
  db: string,
  policy: Policy,
  config: PermDockConfig,
  connect: SqlConnect,
): Promise<VerifyOutcome> {
  const client = await connect(db);
  const scopes = scopeList(policy.scopes);
  const query = async (
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }> => {
    const result = await client.query(
      sql,
      values === undefined ? [] : [...values],
    );
    return { rows: result.rows };
  };
  const loose: QueryFn = async (sql, values) => {
    await query(sql, values);
    return { rows: [] };
  };
  try {
    await query("begin");
    const result = await verifyTree({
      policy,
      config,
      query,
      bind: (subject) =>
        bindSubject(
          loose,
          { subject: { id: subject }, row: {}, action: "read" },
          config.rls?.dialect ?? "supabase",
          config.rls?.gucPrefix ?? "app",
          config.rls?.tenantClaim ?? supabaseTenantClaim,
          config.rls?.roleClaim ?? "user_role",
          [],
          scopes,
        ),
    });
    if (result.mismatches.length > 0) {
      return {
        code: 1,
        output: [...result.mismatches, ...result.notes].join("\n"),
      };
    }
    const verified = `verified ${String(result.checked)} tree check(s) against the database (${String(result.granted)} granted)`;
    return {
      code: 0,
      output:
        result.notes.length === 0
          ? verified
          : `${verified}\n${result.notes.join("\n")}`,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      code: 2,
      output: `PermDock CLI: rls verify --tree could not seed the tree (${message}); connect as a role that owns the tables and is a member of authenticated`,
    };
  } finally {
    await client.query("rollback", []).catch(() => undefined);
    await client.end();
  }
}

export async function runRlsVerify(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly fixtures?: string;
  readonly db?: string;
  readonly from?: string;
  readonly format: "node" | "pgtap";
  /** Check a generated tree with restricted branches instead of fixtures; needs `db`. */
  readonly tree?: boolean;
  readonly io: CliIo;
  /** Opens the `--db` connection; defaults to the `pg` peer. */
  readonly connect?: SqlConnect;
}): Promise<VerifyOutcome> {
  const connect =
    input.connect ??
    ((db: string) => connectPg(db, "permdock rls verify --db"));
  const policyPath = input.from ?? input.config.policy;
  if (policyPath === undefined) {
    return {
      code: 2,
      output: "PermDock CLI: rls verify needs policy in the config or --from",
    };
  }
  const policy: Policy = asPolicy(
    pickNamed(await loadModule(resolve(input.cwd, policyPath)), ["policy"]),
  );
  if (input.tree === true) {
    if (input.db === undefined) {
      return {
        code: 2,
        output: "PermDock CLI: rls verify --tree needs --db",
      };
    }
    try {
      return await verifyTreeAgainstDatabase(
        input.db,
        policy,
        input.config,
        connect,
      );
    } catch (cause) {
      return usageResult(cause);
    }
  }
  const fixturesPath =
    input.fixtures ?? input.config.rls?.fixtures ?? "rls.fixtures.json";
  const { fixtures, customRoles } = await loadFixtures(input.cwd, fixturesPath);
  if (input.format === "pgtap") {
    return {
      code: 0,
      output: emitPgtap(fixtures, customRoles, scopeList(policy.scopes)),
    };
  }
  const mismatches: string[] = [];
  const notes: string[] = [];
  const inProcess: InProcess[] = [];
  const fieldsMode = input.config.rls?.fields === "views";
  for (const fixture of fixtures) {
    const permission = findPermission(policy.permissions, fixture.action);
    if (permission === undefined) {
      mismatches.push(`${fixture.action}: unknown permission`);
      inProcess.push({
        action: fixture.action,
        granted: false,
        kind: "portable",
      });
      continue;
    }
    const kind = grantKind(policy, fixture.action);
    const permdock = await createPermDock(
      policy,
      fixtureSubject(fixture.subject),
      {
        customRoles: memoryRoleSource(customRoles),
      },
    );
    const granted = canFixture(
      permdock,
      permission,
      fixtureRow(fixture, permission.kind),
    );
    const outcome = granted ? "granted" : "denied";
    if (fixture.expected !== undefined && fixture.expected !== outcome) {
      mismatches.push(
        `${fixture.action}: in-process ${outcome}, expected ${fixture.expected}`,
      );
    }
    if (kind === "opaque") {
      notes.push(`${fixture.action}: opaque grant untestable app-side`);
    }
    const reads =
      fieldsMode &&
      permission.kind === "instance" &&
      commandFor(permission.action) === "select";
    // SAFETY: reads is only true when permission.kind === 'instance'.
    const fields = reads
      ? expectedFields(
          granted,
          permdock.pick(
            permission as Permission<string, unknown, "instance">,
            fixture.row,
          ),
          policy.resources.get(permission.resource)?.id ?? "id",
          fixture.row,
        )
      : undefined;
    inProcess.push({
      action: fixture.action,
      granted,
      kind,
      ...(fields === undefined ? {} : { fields }),
    });
  }
  if (input.db !== undefined) {
    try {
      const database = await verifyAgainstDatabase({
        db: input.db,
        policy,
        fixtures,
        customRoles,
        config: input.config,
        inProcess,
        connect,
      });
      mismatches.push(...database.mismatches);
      notes.push(...database.notes);
    } catch (cause) {
      return usageResult(cause);
    }
  }
  if (mismatches.length > 0) {
    return { code: 1, output: [...mismatches, ...notes].join("\n") };
  }
  const verified = `verified ${fixtures.length} fixture(s) in-process`;
  return {
    code: 0,
    output: notes.length === 0 ? verified : `${verified}\n${notes.join("\n")}`,
  };
}
