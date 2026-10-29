import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsApprovalManagers } from "../types.ts";

import { MAX_MANAGER_LEVELS } from "../../core/approvers.ts";
import { configError } from "../core/errors.ts";
import { qualified, quoteIdent, quoteQualified } from "../sql/quote.ts";
import { subjectIdSql } from "../sql/subject.ts";

/** Whether the signed-in user manages a requester; better-supabase reads it. */
export const MANAGES = "permdock_manages";

/**
 * The approver check with `manager` leaves; only `permdock_is_approver` calls
 * it.
 */
export const APPROVES = "permdock_approves";

function named(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function checked(managers: unknown): RlsApprovalManagers {
  if (
    typeof managers !== "object" ||
    managers === null ||
    !("table" in managers && named(managers.table)) ||
    !("user" in managers && named(managers.user)) ||
    !("manager" in managers && named(managers.manager))
  ) {
    throw configError(
      "PermDock CLI: rls.approvals.managers needs { table, user, manager }: the table that names each user's manager, its user column and its manager column",
    );
  }
  return {
    table: managers.table,
    user: managers.user,
    manager: managers.manager,
  };
}

/**
 * `rls.approvals.managers`: `permdock_manages(p_requester, p_levels)` walks the
 * app's manager table up to `levels` steps (at most `MAX_MANAGER_LEVELS`) with
 * a cycle guard, and `permdock_approves` decides `manager` leaves with it and
 * every other leaf through the two-argument `permdock_is_approver`. The
 * requester never manages themselves into an approval. Without `delegations`,
 * the four-argument `permdock_is_approver` is written here; with them,
 * `approvalDelegationsSql` writes it and calls `permdock_approves` first.
 */
export function approvalManagersSql(
  ctx: RlsSqlContext,
  given: unknown,
  isApprover: string,
  delegations: boolean,
): string {
  const managers = checked(given);
  const table = quoteQualified(managers.table);
  const user = quoteIdent(managers.user);
  const boss = quoteIdent(managers.manager);
  const manages = qualified(ctx, MANAGES);
  const approves = qualified(ctx, APPROVES);
  const me = `${subjectIdSql(ctx)}::text`;
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
  return `
-- approval managers: whether the signed-in user manages p_requester within p_levels steps of ${managers.table}
create or replace function ${manages}(p_requester text, p_levels integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with recursive chain (id, depth, path) as (
    select m.${boss}::text, 1, array[p_requester, m.${boss}::text]
    from ${table} m
    where m.${user}::text = p_requester
      and m.${boss} is not null
    union all
    select m.${boss}::text, c.depth + 1, c.path || m.${boss}::text
    from chain c
    join ${table} m on m.${user}::text = c.id
    where c.depth < least(p_levels, ${String(MAX_MANAGER_LEVELS)})
      and m.${boss} is not null
      and not (m.${boss}::text = any (c.path))
  )
  select coalesce(
    p_requester <> ''
      and p_levels between 1 and ${String(MAX_MANAGER_LEVELS)}
      and ${me} <> p_requester
      and exists (select 1 from chain c where c.id = ${me}),
    false
  )
$$;
revoke execute on function ${manages}(text, integer) from public, anon, authenticated;

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
      return coalesce(${manages}(p_requester, v_levels::text::integer), false);
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
      return ${isApprover}(p_approvers, p_tenant);
  end case;
end;
$$;
revoke execute on function ${approves}(jsonb, text, text) from public, anon, authenticated;
${entry}`;
}
