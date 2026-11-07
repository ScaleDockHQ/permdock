import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsApprovalManagers } from "../types.ts";

import { MAX_MANAGER_LEVELS } from "../../core/approvers.ts";
import { qualified, quoteIdent, quoteQualified } from "../sql/quote.ts";
import { subjectIdSql } from "../sql/subject.ts";

/** The caller plus active delegators, one hop. */
const APPROVER_FOR_IDS = "permdock_approver_for_ids";

/** Users the caller manages, walking down `rls.approvals.managers`. */
const MANAGED_USER_IDS = "permdock_managed_user_ids";

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
  const me = `${subjectIdSql(ctx)}::text`;
  const approvers = qualified(ctx, APPROVER_FOR_IDS);
  const covers = options.delegations
    ? `
  union
  select d.delegator::text
  from ${qualified(ctx, "approval_delegations")} d
  where d.delegate::text = ${me}
    and d."from" <= now()
    and d."until" > now()
    and d.delegator::text <> ${me}`
    : "";
  const managed =
    options.managers === undefined ? "" : managedSql(ctx, options.managers, me);
  return `
-- approvers: the caller, plus each active delegator, one hop
create or replace function ${approvers}()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select ${me}
  where coalesce(${me}, '') <> ''${covers}
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
  return `
-- approval managers: users below the caller; the caller is not in the set, so a self-decision stays refused
create or replace function ${fn}()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  with recursive down (id, depth, path) as (
    select m.${user}::text, 1, array[${me}, m.${user}::text]
    from ${table} m
    where m.${boss}::text = ${me}
      and m.${user} is not null
      and m.${user}::text <> ${me}
    union all
    select m.${user}::text, d.depth + 1, d.path || m.${user}::text
    from down d
    join ${table} m on m.${boss}::text = d.id
    where d.depth < ${String(MAX_MANAGER_LEVELS)}
      and m.${user} is not null
      and m.${user}::text <> ${me}
      and not (m.${user}::text = any (d.path))
  )
  select id from down
$$;
revoke execute on function ${fn}() from public, anon;
grant execute on function ${fn}() to authenticated;
`;
}
