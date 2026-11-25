import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsApprovalManagerRows, RlsApprovalManagers } from "../types.ts";

import { MAX_MANAGER_LEVELS } from "../../core/approvers.ts";
import { tenantTypeOf, userTypeOf } from "../sql/columns.ts";
import { qualified, quoteIdent, quoteQualified } from "../sql/quote.ts";
import { subjectIdSql } from "../sql/subject.ts";
import {
  activeRowSql,
  isManagerRows,
  managerEdges,
} from "./approval-managers.ts";

/**
 * The users who may decide a request of `p_requester`; better-supabase reads it
 * as `approverFor`.
 */
export const REQUEST_APPROVER_IDS = "permdock_request_approver_ids";

export const MANAGES_ROW = "permdock_manages_row";
export const MANAGED_ROW_IDS_IN = "permdock_managed_row_ids_in";
export const MANAGED_ROW_IDS = "permdock_managed_row_ids";
export const ACCESSIBLE_ROW_IDS = "permdock_accessible_row_ids";

/**
 * `permdock_request_approver_ids(p_requester, p_tenant, p_resource)`: the
 * requester's managers up the chain, at most `MAX_MANAGER_LEVELS` steps, plus
 * each delegate inside an active cover of one of them for that tenant and
 * resource. The requester is never in the set. With a self-referencing manager
 * table the row helpers follow.
 */
export function approvalChainSql(
  ctx: RlsSqlContext,
  managers: RlsApprovalManagers,
  delegations: boolean,
): string {
  const edges = managerEdges(managers);
  const user = userTypeOf(ctx);
  const tenantType = tenantTypeOf(ctx);
  const fn = qualified(ctx, REQUEST_APPROVER_IDS);
  const oldArgTypes =
    edges.tenant === undefined ? user : `${user}, ${tenantType}`;
  const argTypes = delegations ? `${oldArgTypes}, text` : oldArgTypes;
  const args = `${
    edges.tenant === undefined
      ? `p_requester ${user}`
      : `p_requester ${user}, p_tenant ${tenantType}`
  }${delegations ? ", p_resource text default null" : ""}`;
  const edgeTenant = (alias: string): string =>
    edges.tenant === undefined
      ? ""
      : `\n      and ${alias}.${edges.tenant} = p_tenant`;
  // A cover counts in the request's tenant and resource only, and never one
  // limited to permissions; without p_resource only a cover for every resource.
  const coverScope = `${
    edges.tenant === undefined
      ? "\n    and d.tenant is null"
      : "\n    and (d.tenant is null or d.tenant::text = p_tenant::text)"
  }
    and d.permissions is null
    and (d.resources is null or p_resource = any (d.resources))`;
  const covers = delegations
    ? `
  union
  select d.delegate
  from ${qualified(ctx, "approval_delegations")} d
  join up u on u.id = d.delegator
  where d."from" <= now()
    and d."until" > now()
    and d.delegate <> p_requester${coverScope}`
    : "";
  const chain = `
-- approval managers: who may decide a request of p_requester, the managers up the chain and their active covers
${delegations ? `drop function if exists ${fn}(${oldArgTypes});\n` : ""}create or replace function ${fn}(${args})
returns setof ${user}
language sql
stable
security definer
cost 1000
rows 10
parallel safe
set search_path = ''
as $$
  with recursive up (id, depth, path) as (
    select m.${edges.manager}, 1, array[p_requester, m.${edges.manager}]
    from ${edges.from} m
    where m.${edges.user} = p_requester
      and m.${edges.manager} is not null${edgeTenant("m")}
    union all
    select m.${edges.manager}, u.depth + 1, u.path || m.${edges.manager}
    from up u
    join ${edges.from} m on m.${edges.user} = u.id
    where u.depth < ${String(MAX_MANAGER_LEVELS)}
      and m.${edges.manager} is not null
      and not (m.${edges.manager} = any (u.path))${edgeTenant("m")}
  )
  select id from up where id <> p_requester${covers}
$$;
revoke execute on function ${fn}(${argTypes}) from public, anon;
grant execute on function ${fn}(${argTypes}) to authenticated;
`;
  return isManagerRows(managers) ? chain + rowHelpersSql(ctx, managers) : chain;
}

/**
 * The row helpers of a self-referencing manager table. A row's managers are the
 * rows above it through `reportsTo`; the caller manages a row when one of those
 * rows belongs to the caller. The caller's own rows are not managed by the
 * caller, so a self-decision stays refused.
 */
function rowHelpersSql(
  ctx: RlsSqlContext,
  managers: RlsApprovalManagerRows,
): string {
  const table = quoteQualified(managers.table);
  const id = quoteIdent(managers.id);
  const boss = quoteIdent(managers.reportsTo);
  const user = quoteIdent(managers.user);
  const tenant =
    managers.tenant === undefined ? undefined : quoteIdent(managers.tenant);
  const me = subjectIdSql(ctx);
  const levels = String(MAX_MANAGER_LEVELS);
  const tenantType = tenantTypeOf(ctx);
  const manages = qualified(ctx, MANAGES_ROW);
  const within = qualified(ctx, MANAGED_ROW_IDS_IN);
  const all = qualified(ctx, MANAGED_ROW_IDS);
  const accessible = qualified(ctx, ACCESSIBLE_ROW_IDS);
  const root = ctx.scopes[0]?.name;
  const downFrom = (seed: string): string => `
  with recursive down (id, depth, path) as (
    select r.${id}, 1, array[r.${id}]
    from ${table} m
    join ${table} r on r.${boss} = m.${id}${tenant === undefined ? "" : ` and r.${tenant} = m.${tenant}`}
    where m.${user} = ${me}${seed}${activeRowSql(managers, "m")}${activeRowSql(managers, "r")}
      and r.${user} is distinct from ${me}
    union all
    select r.${id}, d.depth + 1, d.path || r.${id}
    from down d
    join ${table} m on m.${id} = d.id
    join ${table} r on r.${boss} = m.${id}${tenant === undefined ? "" : ` and r.${tenant} = m.${tenant}`}
    where d.depth < ${levels}
      and not (r.${id} = any (d.path))${activeRowSql(managers, "r")}
      and r.${user} is distinct from ${me}
  )
  select id from down`;
  const withinArgs = tenant === undefined ? "" : `p_tenant ${tenantType}`;
  const withinTypes = tenant === undefined ? "" : tenantType;
  const permitted =
    tenant === undefined || root === undefined
      ? ""
      : `
  union
  select r.${id}
  from ${table} r
  where r.${tenant} in (select ${qualified(ctx, `permitted_${root}_ids_by_permission`)}(p_permission))${activeRowSql(managers, "r")}`;
  return `
-- approval managers: whether the caller manages row p_row of ${managers.table}, walking up reportsTo
create or replace function ${manages}(p_row ${table}.${id}%type)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive up (id, depth, path) as (
    select b.${id}, 1, array[r.${id}, b.${id}]
    from ${table} r
    join ${table} b on b.${id} = r.${boss}
    where r.${id} = p_row${activeRowSql(managers, "b")}
    union all
    select b.${id}, u.depth + 1, u.path || b.${id}
    from up u
    join ${table} m on m.${id} = u.id
    join ${table} b on b.${id} = m.${boss}
    where u.depth < ${levels}
      and not (b.${id} = any (u.path))${activeRowSql(managers, "b")}
  )
  select coalesce(
    exists (
      select 1 from up u join ${table} b on b.${id} = u.id
      where b.${user} = ${me}
    )
      and not exists (select 1 from ${table} r where r.${id} = p_row and r.${user} = ${me}),
    false
  )
$$;
revoke execute on function ${manages} from public, anon;
grant execute on function ${manages} to authenticated;

-- approval managers: the rows of ${managers.table} below the caller's rows${tenant === undefined ? "" : " in p_tenant"}
create or replace function ${within}(${withinArgs})
returns setof ${table}.${id}%type
language sql
stable
security definer
cost 1000
rows 50
parallel safe
set search_path = ''
as $$${downFrom(tenant === undefined ? "" : `\n      and m.${tenant} = p_tenant`)}
$$;
revoke execute on function ${within}(${withinTypes}) from public, anon;
grant execute on function ${within}(${withinTypes}) to authenticated;

-- approval managers: the rows of ${managers.table} below the caller's rows in every tenant
create or replace function ${all}()
returns setof ${table}.${id}%type
language sql
stable
security definer
cost 1000
rows 50
parallel safe
set search_path = ''
as $$${downFrom("")}
$$;
revoke execute on function ${all}() from public, anon;
grant execute on function ${all}() to authenticated;

-- approval managers: the caller's own rows, the rows below them${permitted === "" ? "" : " and every row in a tenant where the caller holds p_permission"}
create or replace function ${accessible}(p_permission text)
returns setof ${table}.${id}%type
language sql
stable
security definer
cost 1000
rows 100
parallel safe
set search_path = ''
as $$
  select r.${id} from ${table} r where r.${user} = ${me}${activeRowSql(managers, "r")}
  union
  select m.id from ${all}() m(id)${permitted}
$$;
revoke execute on function ${accessible}(text) from public, anon;
grant execute on function ${accessible}(text) to authenticated;
`;
}
