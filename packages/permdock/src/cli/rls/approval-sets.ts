import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsApprovalManagers } from "../types.ts";

import { MAX_MANAGER_LEVELS } from "../../core/approvers.ts";
import { tenantTypeOf, userTypeOf } from "../sql/columns.ts";
import { qualified, quoteIdent, quoteQualified } from "../sql/quote.ts";
import { subjectIdSql } from "../sql/subject.ts";

/** The caller plus active delegators, one hop. */
export const APPROVER_FOR_IDS = "permdock_approver_for_ids";

/** Users the caller manages, walking down `rls.approvals.managers`. */
export const MANAGED_USER_IDS = "permdock_managed_user_ids";

/**
 * Sets a policy uses to decide an approval in SQL. `permdock_approver_for_ids`
 * is the caller and, with delegations, each active delegator, one hop and no
 * further. `permdock_managed_user_ids` walks down the manager table from the
 * caller. Neither set contains the caller as someone they manage, and a
 * decision still refuses the requester: compare the set with `id <>
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
  const covers = options.delegations
    ? `
  union
  select d.delegator
  from ${qualified(ctx, "approval_delegations")} d
  where d.delegate = ${me}
    and d."from" <= now()
    and d."until" > now()
    and d.delegator <> ${me}`
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
${managed}`;
}

function managedSql(
  ctx: RlsSqlContext,
  managers: RlsApprovalManagers,
  me: string,
): string {
  const fn = qualified(ctx, MANAGED_USER_IDS);
  const table = quoteQualified(managers.table);
  const user = quoteIdent(managers.user);
  const boss = quoteIdent(managers.manager);
  const type = userTypeOf(ctx);
  const tenant =
    managers.tenant === undefined ? undefined : quoteIdent(managers.tenant);
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
