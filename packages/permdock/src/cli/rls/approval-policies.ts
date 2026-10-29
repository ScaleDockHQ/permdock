import type { RlsSqlContext } from "../sql/context.ts";

import { configError } from "../core/errors.ts";
import { memberIdsHelper } from "../sql/names.ts";
import { qualified, quoteIdent, quoteLiteral } from "../sql/quote.ts";
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
export function approvalPoliciesSql(
  ctx: RlsSqlContext,
  options: unknown,
  actorMayWrite = false,
): string {
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
  const root = ctx.scopes[0]?.name;
  if (root === undefined) {
    throw configError(
      "PermDock CLI: rls.approvals.tenantPolicies needs a tenant scope; declare one in the policy's scopes",
    );
  }
  const table = qualified(ctx, APPROVAL_POLICIES.table);
  const fn = qualified(ctx, APPROVAL_POLICIES.read);
  const member = `tenant in (select m.id::text from ${qualified(ctx, memberIdsHelper(root))}() m(id))`;
  const manages = `exists (
      select 1
      from ${qualified(ctx, checkName(permittedByPermissionHelper(root)))}(${quoteLiteral(options.manage)}) i(id)
      where i.id::text = tenant
    )`;
  const writable = actorMayWrite
    ? ` and (select ${qualified(ctx, ACTOR_MAY_WRITE)}())`
    : "";
  const own = `tenant is not null and ${subjectIdSql(ctx)} is not null and ${manages}${writable}`;
  const policy = (name: string): string =>
    quoteIdent(`${APPROVAL_POLICIES.table}_${name}`);
  return `
-- approval policies: requirements a tenant keeps as data, plus platform floors (tenant null); tableApprovalPolicySource reads them
create table if not exists ${table} (
  id text primary key default gen_random_uuid()::text,
  tenant text,
  name text not null,
  body jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ${quoteIdent(`${APPROVAL_POLICIES.table}_body`)} check (jsonb_typeof(body) = 'object' and body ? 'approval')
);
create index if not exists ${quoteIdent(`${APPROVAL_POLICIES.table}_tenant`)} on ${table} (tenant);
alter table ${table} enable row level security;
revoke all on table ${table} from anon, public;
grant select, insert, update, delete on table ${table} to authenticated;
drop policy if exists ${policy("read")} on ${table};
create policy ${policy("read")} on ${table}
  for select to authenticated
  using (tenant is null or ${member});
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
      when p.tenant is null then p.body - 'tenant'
      else p.body || jsonb_build_object('tenant', p.tenant)
    end
  from ${table} p
  where p.enabled
    and (p.tenant is null or p.tenant = any(coalesce(p_tenants, '{}')))
  order by p.tenant nulls first, p.created_at, p.id;
$$;
revoke execute on function ${fn}(text[]) from public, anon, authenticated;
`;
}
