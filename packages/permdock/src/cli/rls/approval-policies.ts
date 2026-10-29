import type { RlsSqlContext } from "../sql/context.ts";
import type {
  RlsApprovalPolicyColumns,
  RlsApprovalPolicies,
} from "../types.ts";

import { configError } from "../core/errors.ts";
import { memberIdsHelper } from "../sql/names.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { subjectIdSql } from "../sql/subject.ts";
import { checkName, permittedByPermissionHelper } from "./permission-keys.ts";
import { ACTOR_MAY_WRITE } from "./policies.ts";

/**
 * The objects `rls.approvals.tenantPolicies` adds; `tableApprovalPolicySource`
 * calls the function.
 */
const APPROVAL_POLICIES = {
  table: "approval_policies",
  read: "permdock_approval_policies_for",
} as const;

const COLUMN_DEFAULTS = {
  id: "id",
  tenant: "tenant",
  name: "name",
  body: "body",
  enabled: "enabled",
  createdAt: "created_at",
} as const satisfies Required<RlsApprovalPolicyColumns>;

const KEY = /^[A-Za-z][\w-]*(?:\.[A-Za-z][\w-]*)+$/u;

/**
 * `rls.approvals.tenantPolicies`: one table of `ApprovalPolicy` bodies, a
 * tenant row per requirement a tenant adds and platform floors with `tenant`
 * null. Members read their tenants' rows and the floors; a holder of `manage`
 * in a tenant writes that tenant's rows; nobody but the owner writes a floor.
 * `permdock_approval_policies_for(p_tenants)` answers the enabled bodies with
 * the row's tenant set, floors first, and only the owner may execute it, since
 * it reads every tenant.
 */
function named(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** `options` with its optional parts checked; `manage` is the only required one. */
function checked(options: unknown): RlsApprovalPolicies {
  if (
    options === null ||
    typeof options !== "object" ||
    !("manage" in options) ||
    typeof options.manage !== "string" ||
    !KEY.test(options.manage)
  ) {
    throw configError(
      "PermDock CLI: rls.approvals.tenantPolicies needs { manage: '<permission key>' }, the permission whose holders in a tenant edit its approval policies",
    );
  }
  const given: Record<string, unknown> = { ...options };
  for (const key of ["table", "function"] as const) {
    if (given[key] !== undefined && !named(given[key])) {
      throw configError(
        `PermDock CLI: rls.approvals.tenantPolicies.${key} must be a non-empty string`,
      );
    }
  }
  const columns = given["columns"];
  if (columns !== undefined) {
    if (typeof columns !== "object" || columns === null) {
      throw configError(
        "PermDock CLI: rls.approvals.tenantPolicies.columns must be an object of column names",
      );
    }
    for (const [key, value] of Object.entries(columns)) {
      if (!Object.hasOwn(COLUMN_DEFAULTS, key) || !named(value)) {
        throw configError(
          `PermDock CLI: rls.approvals.tenantPolicies.columns.${key} must be a column name; the keys are ${Object.keys(COLUMN_DEFAULTS).join(", ")}`,
        );
      }
    }
  }
  const path = given["path"];
  if (path !== undefined && !(Array.isArray(path) && path.every(named))) {
    throw configError(
      "PermDock CLI: rls.approvals.tenantPolicies.path must be a list of keys",
    );
  }
  // SAFETY: manage, table, function, columns and path were checked above.
  return given as unknown as RlsApprovalPolicies;
}

export function approvalPoliciesSql(
  ctx: RlsSqlContext,
  given: unknown,
  actorMayWrite = false,
): string {
  const options = checked(given);
  const root = ctx.scopes[0]?.name;
  if (root === undefined) {
    throw configError(
      "PermDock CLI: rls.approvals.tenantPolicies needs a tenant scope; declare one in the policy's scopes",
    );
  }
  const column = (key: keyof typeof COLUMN_DEFAULTS): string =>
    quoteIdent(options.columns?.[key] ?? COLUMN_DEFAULTS[key]);
  const id = column("id");
  const tenantColumn = column("tenant");
  const name = column("name");
  const bodyColumn = column("body");
  const enabled = column("enabled");
  const createdAt = column("createdAt");
  const path = options.path ?? [];
  // The ApprovalPolicy inside the body column: the column itself unless `path` says otherwise.
  const keys = `{${path.map((key) => `"${key.replaceAll('"', String.raw`\"`)}"`).join(",")}}`;
  const policyIn = (alias: string): string =>
    path.length === 0
      ? `${alias}${bodyColumn}`
      : `(${alias}${bodyColumn} #> ${quoteLiteral(keys)})`;
  const tableName =
    options.table === undefined
      ? APPROVAL_POLICIES.table
      : (options.table.split(".").at(-1) ?? APPROVAL_POLICIES.table);
  const table =
    options.table === undefined
      ? qualified(ctx, APPROVAL_POLICIES.table)
      : quoteQualified(options.table);
  const fn = qualified(ctx, options.function ?? APPROVAL_POLICIES.read);
  const member = `${tenantColumn} in (select m.id::text from ${qualified(ctx, memberIdsHelper(root))}() m(id))`;
  const manages = `exists (
      select 1
      from ${qualified(ctx, checkName(permittedByPermissionHelper(root)))}(${quoteLiteral(options.manage)}) i(id)
      where i.id::text = ${tenantColumn}
    )`;
  const writable = actorMayWrite
    ? ` and (select ${qualified(ctx, ACTOR_MAY_WRITE)}())`
    : "";
  const own = `${tenantColumn} is not null and ${subjectIdSql(ctx)} is not null and ${manages}${writable}`;
  const policy = (suffix: string): string =>
    quoteIdent(`${tableName}_${suffix}`);
  return `
-- approval policies: requirements a tenant keeps as data, plus platform floors (tenant null); tableApprovalPolicySource reads them
create table if not exists ${table} (
  ${id} text primary key default gen_random_uuid()::text,
  ${tenantColumn} text,
  ${name} text not null,
  ${bodyColumn} jsonb not null,
  ${enabled} boolean not null default true,
  ${createdAt} timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ${quoteIdent(`${tableName}_body`)} check (jsonb_typeof(${policyIn("")}) = 'object' and ${policyIn("")} ? 'approval')
);
create index if not exists ${quoteIdent(`${tableName}_tenant`)} on ${table} (${tenantColumn});
alter table ${table} enable row level security;
revoke all on table ${table} from anon, public;
grant select, insert, update, delete on table ${table} to authenticated;
drop policy if exists ${policy("read")} on ${table};
create policy ${policy("read")} on ${table}
  for select to authenticated
  using (${tenantColumn} is null or ${member});
drop policy if exists ${policy("insert")} on ${table};
create policy ${policy("insert")} on ${table}
  for insert to authenticated
  with check (${own});
drop policy if exists ${policy("update")} on ${table};
create policy ${policy("update")} on ${table}
  for update to authenticated
  using (${own})
  with check (${own});
drop policy if exists ${policy("delete")} on ${table};
create policy ${policy("delete")} on ${table}
  for delete to authenticated
  using (${own});

-- approval policies: the enabled bodies for p_tenants and every floor, with the row's tenant; only the owner executes it
create or replace function ${fn}(p_tenants text[])
returns setof jsonb
language sql
stable
set search_path = ''
as $$
  select case
      when p.${tenantColumn} is null then ${policyIn("p.")} - 'tenant'
      else ${policyIn("p.")} || jsonb_build_object('tenant', p.${tenantColumn})
    end
  from ${table} p
  where p.${enabled}
    and (p.${tenantColumn} is null or p.${tenantColumn} = any(coalesce(p_tenants, '{}')))
  order by p.${tenantColumn} nulls first, p.${createdAt}, p.${id};
$$;
revoke execute on function ${fn}(text[]) from public, anon, authenticated;
`;
}
