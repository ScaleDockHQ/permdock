import type { RlsFixture } from "../fixtures.ts";
import type { PermDockConfig, RlsDialect } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { customRoleScope, membershipsClaim } from "../../core/custom-roles.ts";
import { type Scope, scopeList } from "../../core/scopes.ts";
import { defaultSqlCommand } from "../../core/sql.ts";
import { type CustomRole, type Policy, findPermission } from "../../index.ts";
import { supabaseTenantClaim } from "../../supabase/budget.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { quoteIdent, quoteLiteral, quoteTable } from "../sql/quote.ts";
import { customRolesOn } from "../sql/shared.ts";
import { membershipSourcesOf } from "../sql/sources.ts";
import { tableNameOf } from "../sql/tables.ts";
import { fixtureMembershipSql } from "./verify-pgtap-memberships.ts";

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
export function statementFor(
  fixture: RlsFixture,
  action: string,
  table: string,
): Statement {
  const quoted = quoteTable(table);
  const id = quoteIdent("id");
  const key = rowId(fixture.row);
  const command = defaultSqlCommand(action) ?? "select";
  switch (command) {
    case "select":
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
    case "insert": {
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
    default: {
      const unhandled: never = command;
      return unhandled;
    }
  }
}

export function rowId(row: unknown): unknown {
  if (isRecord(row) && "id" in row) {
    return row["id"];
  }
  return undefined;
}

/** A fixture value as a SQL literal; untyped, so it coerces to the column like a bound parameter. */
function sqlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  return quoteLiteral(
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

function inlineStatement(statement: Statement): string {
  return statement.sql.replaceAll(/\$(\d+)/gu, (_, index: string) =>
    sqlValue(statement.values[Number(index) - 1]),
  );
}

const PGTAP_DECISION = "pg_temp.permdock_decision";

const PGTAP_DECISION_SQL = `create function ${PGTAP_DECISION}(statement text) returns text
language plpgsql
as $$
declare
  affected bigint;
begin
  execute statement;
  get diagnostics affected = row_count;
  return case when affected > 0 then 'granted' else 'denied' end;
exception
  when others then
    return 'denied';
end;
$$;`;

export type Subject = {
  readonly dialect: RlsDialect;
  readonly gucPrefix: string;
  readonly tenantClaim: string;
  readonly roleClaim: string;
  readonly customRoles: readonly CustomRole[];
  readonly scopes: readonly Scope[];
};

export function subjectOf(
  config: PermDockConfig,
  customRoles: readonly CustomRole[],
  scopes: readonly Scope[],
): Subject {
  return {
    dialect: config.rls?.dialect ?? "supabase",
    gucPrefix: config.rls?.gucPrefix ?? "app",
    tenantClaim: config.rls?.tenantClaim ?? supabaseTenantClaim,
    roleClaim: config.rls?.roleClaim ?? "user_role",
    customRoles,
    scopes,
  };
}

/** The settings that bind a fixture's subject: the GUCs, or the Supabase JWT claims. */
export function subjectSettings(
  fixture: RlsFixture,
  subject: Subject,
): readonly (readonly [string, string])[] {
  const roles = fixture.subject.roles ?? [];
  const memberships = membershipsClaim(
    fixture.subject.memberships ?? [],
    subject.customRoles,
    subject.scopes,
  );
  if (subject.dialect === "guc") {
    const settings: (readonly [string, string])[] = [
      [`${subject.gucPrefix}.user_id`, fixture.subject.id],
      [`${subject.gucPrefix}.${subject.roleClaim}`, roles.join(",")],
      [`${subject.gucPrefix}.memberships`, JSON.stringify(memberships)],
    ];
    if (fixture.subject.tenant !== undefined) {
      settings.push([
        `${subject.gucPrefix}.${subject.tenantClaim}`,
        fixture.subject.tenant,
      ]);
    }
    return settings;
  }
  const claims = {
    ...fixture.subject.claims,
    sub: fixture.subject.id,
    role: "authenticated",
    [subject.roleClaim]: roles.length === 1 ? roles[0] : roles,
    [subject.tenantClaim]: fixture.subject.tenant,
    memberships,
  };
  return [["request.jwt.claims", JSON.stringify(claims)]];
}

type CustomRoleRow = {
  readonly sql: string;
  readonly values: readonly unknown[];
};

/** The `custom_role_*` rows for the fixtures' custom roles; existing rows are kept. */
export function customRoleRows(
  schema: string,
  customRoles: readonly CustomRole[],
  scopes: readonly Scope[],
): readonly CustomRoleRow[] {
  const table = (name: string): string =>
    `${quoteIdent(schema)}.${quoteIdent(name)}`;
  const rows: CustomRoleRow[] = [];
  for (const role of customRoles) {
    const at = customRoleAt(role, scopes);
    if (at.scope === undefined) {
      continue;
    }
    for (const grant of role.grants ?? []) {
      rows.push({
        sql:
          grant.level === undefined
            ? `insert into ${table("custom_role_permissions")} (tenant_id, scope, scope_id, role, permission, effect) values ($1, $2, $3, $4, $5, $6) on conflict do nothing`
            : `insert into ${table("custom_role_permissions")} (tenant_id, scope, scope_id, role, permission, effect, level) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
        values: [
          role.tenant ?? null,
          at.scope,
          at.id ?? null,
          role.name,
          grant.permission,
          grant.effect ?? "allow",
          ...(grant.level === undefined ? [] : [grant.level]),
        ],
      });
    }
    for (const name of role.includes ?? []) {
      rows.push({
        sql: `insert into ${table("custom_role_includes")} (tenant_id, scope, scope_id, role, include_role) values ($1, $2, $3, $4, $5) on conflict do nothing`,
        values: [role.tenant ?? null, at.scope, at.id ?? null, role.name, name],
      });
    }
  }
  return rows;
}

function databaseMode(config: PermDockConfig): boolean {
  const rls = config.rls;
  return (rls?.authorize ?? rls?.rbac?.authorize ?? "jwt") === "database";
}

export function seedsCustomRoleTables(config: PermDockConfig): boolean {
  return customRolesOn(config.rls) && databaseMode(config);
}

export function customRoleSchema(config: PermDockConfig): string {
  return config.rls?.schema ?? config.rls?.rbac?.schema ?? PERMDOCK_SCHEMA;
}

/**
 * A pgTAP script that runs each fixture's statement under the fixture's
 * subject and asserts the outcome `can()` gave in-process.
 */
export function emitPgtap(input: {
  readonly fixtures: readonly RlsFixture[];
  readonly inProcess: readonly InProcess[];
  readonly policy: Policy;
  readonly config: PermDockConfig;
  readonly customRoles: readonly CustomRole[];
}): string {
  const scopes = scopeList(input.policy.scopes);
  const subject = subjectOf(input.config, input.customRoles, scopes);
  const lines = [
    "begin;",
    `select plan(${String(input.fixtures.length)});`,
    PGTAP_DECISION_SQL,
  ];
  if (seedsCustomRoleTables(input.config)) {
    for (const row of customRoleRows(
      customRoleSchema(input.config),
      input.customRoles,
      scopes,
    )) {
      lines.push(`${inlineStatement(row)};`);
    }
  }
  const sources = membershipSourcesOf(input.config).map(
    (source) => source.sql.manifest,
  );
  for (const [index, fixture] of input.fixtures.entries()) {
    const permission = findPermission(input.policy.permissions, fixture.action);
    const status = input.inProcess[index];
    const label = `fixture ${String(index)} ${fixture.action}`;
    if (permission === undefined || status === undefined) {
      continue;
    }
    if (status.kind === "opaque") {
      lines.push(
        `select skip(${quoteLiteral(`${label}: opaque grant untestable app-side`)}, 1);`,
      );
      continue;
    }
    const outcome = status.granted ? "granted" : "denied";
    const table = tableNameOf(
      input.config.rls?.tables?.[permission.resource],
      permission.resource,
    );
    const statement = inlineStatement(
      statementFor(fixture, permission.action, table),
    );
    lines.push(
      `-- ${label}`,
      "savepoint permdock_fixture;",
      ...(databaseMode(input.config)
        ? fixtureMembershipSql(input.config, scopes, fixture, sources)
        : []),
      'set local role "authenticated";',
      ...subjectSettings(fixture, subject).map(
        ([name, value]) =>
          `select set_config(${quoteLiteral(name)}, ${quoteLiteral(value)}, true);`,
      ),
      `select is(${PGTAP_DECISION}(${quoteLiteral(statement)}), ${quoteLiteral(outcome)}, ${quoteLiteral(`${label} ${outcome}`)});`,
      "rollback to savepoint permdock_fixture;",
    );
  }
  lines.push("select * from finish();", "rollback;");
  return `${lines.join("\n")}\n`;
}

export type InProcess = {
  readonly action: string;
  readonly granted: boolean;
  readonly kind: "opaque" | "sqlFunction" | "portable";
  /** With field views: the columns `pick` keeps that hold a value, plus the key. */
  readonly fields?: readonly string[];
};
