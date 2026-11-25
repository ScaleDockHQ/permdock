import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsApprovalManagers } from "../types.ts";

import { MAX_MANAGER_LEVELS } from "../../core/approvers.ts";
import { tenantTypeOf, userTypeOf } from "../sql/columns.ts";
import { qualified } from "../sql/quote.ts";
import { subjectIdSql } from "../sql/subject.ts";
import { managerEdges } from "./approval-managers.ts";

/** The caller plus active delegators, one hop. */
export const APPROVER_FOR_IDS = "permdock_approver_for_ids";

/** Users the caller manages, walking down `rls.approvals.managers`. */
export const MANAGED_USER_IDS = "permdock_managed_user_ids";

/**
 * Sets a policy uses to decide an approval in SQL. `permdock_approver_for_ids`
 * is the caller and, with delegations, each active delegator, one hop and no
 * further, through a cover for every tenant, permission and resource only; its
 * two-argument form \`(p_tenant, p_resource)\` also follows a cover for that
 * tenant and resource. `permdock_managed_user_ids` walks down the manager table
 * from the caller. Neither set contains the caller as someone they manage, and
 * a decision still refuses the requester: compare the set with `id <>
 * <requester>`.
 */
export function approvalSetsSql(
  ctx: RlsSqlContext,
  options: {
    readonly delegations: boolean;
    readonly managers?: RlsApprovalManagers;
  },
): string {
  const me = subjectIdSql(ctx);
  const user = userTypeOf(ctx);
  const approvers = qualified(ctx, APPROVER_FOR_IDS);
  const cover = (tenant: string, resource: string): string => `
  union
  select d.delegator
  from ${qualified(ctx, "approval_delegations")} d
  where d.delegate = ${me}
    and d."from" <= now()
    and d."until" > now()
    and d.delegator <> ${me}
    and ${tenant}
    and d.permissions is null
    and ${resource}`;
  const covers = options.delegations
    ? cover("d.tenant is null", "d.resources is null")
    : "";
  // The same set inside one tenant and for one resource: a cover counts in its
  // own tenant and for a resource it lists; a null p_resource takes only a
  // cover for every resource.
  const scoped = options.delegations
    ? `
-- approvers in a tenant and for a resource: the caller, plus each delegator whose active cover matches them
create or replace function ${approvers}(p_tenant text, p_resource text)
returns setof ${user}
language sql
stable
security definer
cost 100
rows 5
parallel safe
set search_path = ''
as $$
  select ${me}
  where ${me} is not null${cover(
    "(d.tenant is null or d.tenant::text = p_tenant)",
    "(d.resources is null or p_resource = any (d.resources))",
  )}
$$;
revoke execute on function ${approvers}(text, text) from public, anon;
grant execute on function ${approvers}(text, text) to authenticated;
`
    : "";
  const managed =
    options.managers === undefined ? "" : managedSql(ctx, options.managers, me);
  return `
-- approvers: the caller, plus each active delegator, one hop
create or replace function ${approvers}()
returns setof ${user}
language sql
stable
security definer
cost 100
rows 5
parallel safe
set search_path = ''
as $$
  select ${me}
  where ${me} is not null${covers}
$$;
revoke execute on function ${approvers}() from public, anon;
grant execute on function ${approvers}() to authenticated;
${scoped}${managed}`;
}

function managedSql(
  ctx: RlsSqlContext,
  managers: RlsApprovalManagers,
  me: string,
): string {
  const fn = qualified(ctx, MANAGED_USER_IDS);
  const edges = managerEdges(managers);
  const table = edges.from;
  const user = edges.user;
  const boss = edges.manager;
  const type = userTypeOf(ctx);
  const tenant = edges.tenant;
  const argType = tenant === undefined ? "" : tenantTypeOf(ctx);
  const argument = tenant === undefined ? "" : `p_tenant ${argType}`;
  const seedTenant =
    tenant === undefined ? "" : `\n      and m.${tenant} = p_tenant`;
  const stepTenant =
    tenant === undefined ? "" : `\n      and m.${tenant} = p_tenant`;
  return `
-- approval managers: users below the caller within p_tenant; the caller is not in the set, so a self-decision stays refused
create or replace function ${fn}(${argument})
returns setof ${type}
language sql
stable
security definer
cost 1000
rows 50
parallel safe
set search_path = ''
as $$
  with recursive down (id, depth, path) as (
    select m.${user}, 1, array[${me}, m.${user}]
    from ${table} m
    where m.${boss} = ${me}
      and m.${user} is not null
      and m.${user} <> ${me}${seedTenant}
    union all
    select m.${user}, d.depth + 1, d.path || m.${user}
    from down d
    join ${table} m on m.${boss} = d.id
    where d.depth < ${String(MAX_MANAGER_LEVELS)}
      and m.${user} is not null
      and m.${user} <> ${me}
      and not (m.${user} = any (d.path))${stepTenant}
  )
  select id from down
$$;
revoke execute on function ${fn}(${argType}) from public, anon;
grant execute on function ${fn}(${argType}) to authenticated;
`;
}
