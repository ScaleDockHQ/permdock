import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsApprovalManagerRows, RlsApprovalManagers } from "../types.ts";

import { MAX_MANAGER_LEVELS } from "../../core/approvers.ts";
import { configError } from "../core/errors.ts";
import { tenantTypeOf } from "../sql/columns.ts";
import {
  qualified,
  quoteIdent,
  quoteQualified,
  quoteLiteral,
} from "../sql/quote.ts";
import { subjectIdSql } from "../sql/subject.ts";

/** Whether the signed-in user manages a requester; better-supabase reads it. */
export const MANAGES = "permdock_manages";

/**
 * The approver check with `manager` leaves; only `permdock_is_approver` calls
 * it.
 */
export const APPROVES = "permdock_approves";

export const MANAGES_FOR = "permdock_manages_for";

function named(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function names(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string")
  );
}

/**
 * The manager relation the walks read, as one edge per user and manager: an
 * edge table as written, or a self-referencing row table joined to itself.
 */
export type ManagerEdges = {
  /** A relation for `from`: a quoted table or a parenthesised select. */
  readonly from: string;
  readonly user: string;
  readonly manager: string;
  readonly tenant?: string;
};

function activeRows(
  active: unknown,
): RlsApprovalManagerRows["active"] | undefined {
  if (active === undefined) {
    return undefined;
  }
  if (
    typeof active !== "object" ||
    active === null ||
    !("status" in active && named(active.status)) ||
    ("active" in active && !names(active.active)) ||
    ("inactive" in active && !names(active.inactive)) ||
    !("active" in active || "inactive" in active)
  ) {
    throw configError(
      "PermDock CLI: rls.approvals.managers.active needs { status } and a non-empty `active` or `inactive` list of status values",
    );
  }
  return {
    status: active.status,
    ...("active" in active && names(active.active)
      ? { active: active.active }
      : {}),
    ...("inactive" in active && names(active.inactive)
      ? { inactive: active.inactive }
      : {}),
  };
}

/** Validates `rls.approvals.managers` in either form. */
export function checkedManagers(
  managers: unknown,
  ctx: Pick<RlsSqlContext, "scopes">,
): RlsApprovalManagers {
  const rows =
    typeof managers === "object" &&
    managers !== null &&
    ("reportsTo" in managers || "id" in managers);
  if (
    typeof managers !== "object" ||
    managers === null ||
    !("table" in managers && named(managers.table)) ||
    !("user" in managers && named(managers.user)) ||
    (rows
      ? !("id" in managers && named(managers.id)) ||
        !("reportsTo" in managers && named(managers.reportsTo))
      : !("manager" in managers && named(managers.manager)))
  ) {
    throw configError(
      rows
        ? "PermDock CLI: rls.approvals.managers needs { table, id, reportsTo, user } for a self-referencing table: its id column, the column naming the manager's row and the user column"
        : "PermDock CLI: rls.approvals.managers needs { table, user, manager }: the table that names each user's manager, its user column and its manager column",
    );
  }
  const tenant = "tenant" in managers ? managers.tenant : undefined;
  if (tenant !== undefined && !named(tenant)) {
    throw configError(
      "PermDock CLI: rls.approvals.managers.tenant must be a column name",
    );
  }
  if (tenant === undefined && ctx.scopes.length > 0) {
    throw configError(
      "PermDock CLI: rls.approvals.managers needs `tenant`, the column of the manager table or view that holds each edge's tenant; without it an edge in one tenant would count in every tenant",
    );
  }
  const withTenant = tenant === undefined ? {} : { tenant };
  if (
    rows &&
    "id" in managers &&
    named(managers.id) &&
    "reportsTo" in managers &&
    named(managers.reportsTo)
  ) {
    const active = activeRows(
      "active" in managers ? managers.active : undefined,
    );
    return {
      table: managers.table,
      id: managers.id,
      reportsTo: managers.reportsTo,
      user: managers.user,
      ...withTenant,
      ...(active === undefined ? {} : { active }),
    };
  }
  if (!("manager" in managers && named(managers.manager))) {
    throw configError(
      "PermDock CLI: rls.approvals.managers needs { table, user, manager }",
    );
  }
  return {
    table: managers.table,
    user: managers.user,
    manager: managers.manager,
    ...withTenant,
  };
}

export function isManagerRows(
  managers: RlsApprovalManagers,
): managers is RlsApprovalManagerRows {
  return "reportsTo" in managers;
}

function literalList(values: readonly string[]): string {
  return values.map((value) => quoteLiteral(value)).join(", ");
}

/** The row filter of `active`, over `alias`; empty when every row counts. */
export function activeRowSql(
  managers: RlsApprovalManagerRows,
  alias: string,
): string {
  const active = managers.active;
  if (active === undefined) {
    return "";
  }
  const status = `${alias}.${quoteIdent(active.status)}`;
  return [
    ...(active.active === undefined
      ? []
      : [`${status} in (${literalList(active.active)})`]),
    ...(active.inactive === undefined
      ? []
      : [
          `(${status} is null or ${status} not in (${literalList(active.inactive)}))`,
        ]),
  ]
    .map((clause) => ` and ${clause}`)
    .join("");
}

/** `rls.approvals.managers` as one edge per user and manager. */
export function managerEdges(managers: RlsApprovalManagers): ManagerEdges {
  if (!isManagerRows(managers)) {
    return {
      from: quoteQualified(managers.table),
      user: quoteIdent(managers.user),
      manager: quoteIdent(managers.manager),
      ...(managers.tenant === undefined
        ? {}
        : { tenant: quoteIdent(managers.tenant) }),
    };
  }
  const table = quoteQualified(managers.table);
  const user = quoteIdent(managers.user);
  const tenant =
    managers.tenant === undefined ? undefined : quoteIdent(managers.tenant);
  const tenantColumn =
    tenant === undefined ? "" : `, e.${tenant} as "tenant_id"`;
  const sameTenant =
    tenant === undefined ? "" : ` and b.${tenant} = e.${tenant}`;
  return {
    from: `(select e.${user} as "user_id", b.${user} as "manager_id"${tenantColumn} from ${table} e join ${table} b on b.${quoteIdent(managers.id)} = e.${quoteIdent(managers.reportsTo)}${sameTenant} where e.${user} is not null${activeRowSql(managers, "e")}${activeRowSql(managers, "b")})`,
    user: '"user_id"',
    manager: '"manager_id"',
    ...(tenant === undefined ? {} : { tenant: '"tenant_id"' }),
  };
}

/**
 * `rls.approvals.managers`: `permdock_manages(p_requester, p_levels)` walks the
 * app's manager table, keeping the edges of `p_tenant`, up to `levels` steps
 * (at most `MAX_MANAGER_LEVELS`) with a cycle guard, and `permdock_approves`
 * decides `manager` leaves with it and every other leaf through `base`, the
 * two-argument check. The requester never manages themselves into an approval.
 * `permdock_is_approver(p_approvers, p_tenant, p_requester)` routes through
 * `permdock_approves`, so the call with a requester decides `manager` leaves;
 * without one they match nobody. Without `delegations`, the four-argument
 * `permdock_is_approver` is written here; with them, `approvalDelegationsSql`
 * writes it and calls `permdock_approves` first.
 */
export function approvalManagersSql(
  ctx: RlsSqlContext,
  given: unknown,
  isApprover: string,
  base: string,
  delegations: boolean,
): string {
  const managers = checkedManagers(given, ctx);
  const edges = managerEdges(managers);
  const table = edges.from;
  const user = edges.user;
  const boss = edges.manager;
  const manages = qualified(ctx, MANAGES);
  const managesFor = qualified(ctx, MANAGES_FOR);
  const approves = qualified(ctx, APPROVES);
  const me = `${subjectIdSql(ctx)}::text`;
  const tenant = edges.tenant;
  const edgeTenant = (alias: string): string =>
    tenant === undefined
      ? ""
      : `\n      and ${alias}.${tenant} = p_tenant::${tenantTypeOf(ctx)}`;
  // The parameter is cast to the column's type, never the column, so an index on the edge table applies.
  const userType = ctx.dialect === "supabase" ? "uuid" : "text";
  const entry = delegations
    ? ""
    : `
-- approvers with managers: permdock_approves for the signed-in user
create or replace function ${isApprover}(p_approvers jsonb, p_tenant text, p_requester text, p_resource text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select ${approves}(p_approvers, p_tenant, p_requester)
$$;
revoke execute on function ${isApprover}(jsonb, text, text, text) from public, anon;
grant execute on function ${isApprover}(jsonb, text, text, text) to authenticated;
`;
  const twoArguments = `
-- approvers with managers: the two-argument call decides manager leaves when it passes the requester
create or replace function ${isApprover}(p_approvers jsonb, p_tenant text default null, p_requester text default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(${approves}(p_approvers, p_tenant, p_requester), false)
$$;
revoke execute on function ${isApprover}(jsonb, text, text) from public, anon;
grant execute on function ${isApprover}(jsonb, text, text) to authenticated;
`;
  return `
-- approval managers: whether p_user manages p_requester within p_levels steps of ${managers.table}
create or replace function ${managesFor}(p_user text, p_requester text, p_levels integer, p_tenant text default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive chain (id, depth, path) as (
    select m.${boss}::text, 1, array[p_requester, m.${boss}::text]
    from ${table} m
    where m.${user} = p_requester::${userType}
      and m.${boss} is not null${edgeTenant("m")}
    union all
    select m.${boss}::text, c.depth + 1, c.path || m.${boss}::text
    from chain c
    join ${table} m on m.${user} = c.id::${userType}
    where c.depth < least(p_levels, ${String(MAX_MANAGER_LEVELS)})
      and m.${boss} is not null
      and not (m.${boss}::text = any (c.path))${edgeTenant("m")}
  )
  select coalesce(
    p_requester <> ''
      and p_user <> ''
      and p_levels between 1 and ${String(MAX_MANAGER_LEVELS)}
      and p_user <> p_requester
      and exists (select 1 from chain c where c.id = p_user),
    false
  )
$$;
revoke execute on function ${managesFor}(text, text, integer, text) from public, anon, authenticated;

-- approval managers: whether the signed-in user manages p_requester within p_levels steps of ${managers.table}
create or replace function ${manages}(p_requester text, p_levels integer, p_tenant text default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select ${managesFor}(${me}, p_requester, p_levels, p_tenant)
$$;
revoke execute on function ${manages}(text, integer, text) from public, anon, authenticated;

-- approval managers: approvers.by with manager leaves; only permdock_is_approver calls it
create or replace function ${approves}(p_approvers jsonb, p_tenant text, p_requester text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_levels jsonb;
begin
  if p_approvers is null then
    return false;
  end if;
  if jsonb_typeof(p_approvers) = 'array' then
    if jsonb_array_length(p_approvers) = 0 then
      return false;
    end if;
    for v_item in select value from jsonb_array_elements(p_approvers) loop
      if not ${approves}(v_item, p_tenant, p_requester) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  if jsonb_typeof(p_approvers) <> 'object' then
    return false;
  end if;
  case p_approvers ->> 'kind'
    when 'manager' then
      v_levels := coalesce(p_approvers -> 'levels', '1'::jsonb);
      if jsonb_typeof(v_levels) <> 'number' or v_levels::text !~ '^[0-9]{1,2}$' then
        return false;
      end if;
      return coalesce(${manages}(p_requester, v_levels::text::integer, p_tenant), false);
    when 'any-of' then
      if jsonb_typeof(p_approvers -> 'of') <> 'array' then
        return false;
      end if;
      for v_item in select value from jsonb_array_elements(p_approvers -> 'of') loop
        if ${approves}(v_item, p_tenant, p_requester) then
          return true;
        end if;
      end loop;
      return false;
    else
      return ${base}(p_approvers, p_tenant);
  end case;
end;
$$;
revoke execute on function ${approves}(jsonb, text, text) from public, anon, authenticated;
${twoArguments}${entry}`;
}
