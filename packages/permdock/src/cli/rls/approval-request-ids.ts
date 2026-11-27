import type { RlsSqlContext } from "../sql/context.ts";

import { userTypeOf } from "../sql/columns.ts";
import { memberIdsHelper } from "../sql/names.ts";
import { qualified } from "../sql/quote.ts";
import { subjectIdSql } from "../sql/subject.ts";
import { MANAGES_FOR } from "./approval-managers.ts";
import {
  PERMISSION_HELPERS,
  checkName,
  permittedByPermissionHelper,
} from "./permission-keys.ts";

/**
 * The approver check as a set: the ids of the requests the caller may approve,
 * each decided as better-supabase's `isApprover` template decides it.
 */
export const APPROVER_REQUEST_IDS = "permdock_approver_request_ids";

/**
 * The approver check over facts read once; only `permdock_approver_request_ids`
 * calls it.
 */
const APPROVER_MATCHES = "permdock_approver_matches";

/**
 * The most requests one `permdock_approver_request_ids` call takes; a longer
 * `p_requests` raises `54000`, so one call never walks an unbounded array.
 */
export const MAX_APPROVER_REQUESTS = 5000;

/** The function `rls.approvals.delegations` writes for a cover's own rights. */
const COVER_APPROVES = "permdock_cover_approves";

/**
 * `permdock_approver_request_ids(p_requests jsonb, p_kinds jsonb, p_current
 * boolean default false)`: the `id` of every element of `p_requests` (`{ id,
 * kind, tenant, requester, approvers }`, the placeholders of better-supabase's
 * `isApprover`) whose request the signed-in user may approve. `p_kinds` maps a
 * kind to its approvers, and `p_current` passes each element's `approvers`, as
 * the provider's `approvers` and `requestApprovers` options do. An element
 * answers as `permdock_is_approver` does for it, but the caller's `holder()`,
 * manager and cover facts are read once per call, not once per request. A
 * policy or a set query calls it uncorrelated, so Postgres runs it once per
 * statement. More than `MAX_APPROVER_REQUESTS` elements raise `54000`, and a
 * `p_kinds` entry under the empty kind matches nothing.
 */
export function approverRequestIdsSql(
  ctx: RlsSqlContext,
  options: { readonly managers: boolean; readonly delegations: boolean },
): string {
  const fn = qualified(ctx, APPROVER_REQUEST_IDS);
  // Without managers or covers, permdock_is_approver takes no requester and no
  // current approvers, so p_current changes nothing.
  const covering = options.managers || options.delegations;
  const approvers = covering
    ? `case when p_current then
        jsonb_build_object(
          'kind', 'any-of',
          'of',
          case when r.approvers is null then '[]'::jsonb else jsonb_build_array(r.approvers) end
            || case
              when jsonb_typeof(r.current -> 'users') = 'array' then coalesce(
                (select jsonb_agg(jsonb_build_object('kind', 'user', 'id', u.id)) from jsonb_array_elements_text(r.current -> 'users') u(id)),
                '[]'::jsonb
              )
              else '[]'::jsonb
            end
            || case when r.current -> 'manager' = 'true'::jsonb then '[{"kind": "manager"}]'::jsonb else '[]'::jsonb end
            || case
              when jsonb_typeof(r.current -> 'permission') = 'string'
                then jsonb_build_array(jsonb_build_object('kind', 'permission', 'permission', r.current ->> 'permission'))
              else '[]'::jsonb
            end
        )
        else r.approvers end`
    : "r.approvers";
  const kept = covering ? "r.listed or p_current" : "r.listed";
  // An empty kind is no request's kind, as the isApprover template skips it.
  const listed = `jsonb_typeof(p_kinds) = 'object' and e ->> 'kind' <> '' and p_kinds ? (e ->> 'kind')`;
  const resource = `case when strpos(e ->> 'kind', '.') > 1 then split_part(e ->> 'kind', '.', 1) else e ->> 'kind' end`;
  const matches = qualified(ctx, APPROVER_MATCHES);
  const root = ctx.scopes[0]?.name;
  const user = userTypeOf(ctx);
  const managerCase = options.managers
    ? `
    when 'manager' then
      v_levels := coalesce(p_approvers -> 'levels', '1'::jsonb);
      if jsonb_typeof(v_levels) <> 'number' or v_levels::text !~ '^[0-9]{1,2}$' then
        return false;
      end if;
      return coalesce((p_facts -> 'manages' ->> jsonb_build_array(p_requester, p_tenant, v_levels::text::integer)::text)::boolean, false);`
    : "";
  const tenantFacts =
    root === undefined
      ? "'{}'::jsonb"
      : `(
      select coalesce(jsonb_object_agg(p.permission, (
        select coalesce(jsonb_agg(i.id::text), '[]'::jsonb)
        from ${qualified(ctx, checkName(permittedByPermissionHelper(root)))}(p.permission) i(id)
      )), '{}'::jsonb)
      from (select distinct l.permission from leaves l where l.within is not null and l.permission is not null) p
    )`;
  const managerLeaves = options.managers
    ? `,
  managers as (
    select distinct r ->> 'requester' as requester, r ->> 'within' as within, coalesce(l -> 'levels', '1'::jsonb) as levels
    from jsonb_array_elements(v_requests) r, jsonb_path_query(r -> 'approvers', 'strict $.** ? (@.kind == "manager")') l
  )`
    : "";
  const managerFacts = options.managers
    ? `,
    'manages', (
      select coalesce(jsonb_object_agg(
        jsonb_build_array(m.requester, m.within, m.levels::text::integer)::text,
        coalesce(${qualified(ctx, MANAGES_FOR)}(v_user, m.requester, m.levels::text::integer, m.within), false)
      ), '{}'::jsonb)
      from managers m
      where jsonb_typeof(m.levels) = 'number' and m.levels::text ~ '^[0-9]{1,2}$'
    )`
    : "";
  const member =
    root === undefined
      ? `    if v_request ->> 'within' is not null then
      continue;
    end if;`
      : `    if v_request ->> 'within' is not null then
      if v_member is null then
        select coalesce(array_agg(m.id::text), '{}') into v_member from ${qualified(ctx, memberIdsHelper(root))}() m(id);
      end if;
      if not (v_request ->> 'within' = any (v_member)) then
        continue;
      end if;
    end if;`;
  const covers = options.delegations
    ? `
    if coalesce(v_request ->> 'requester', '') = '' then
      continue;
    end if;
    if v_covers is null then
      select coalesce(jsonb_agg(jsonb_build_object('delegator', d.delegator, 'within', d.tenant, 'resources', d.resources)), '[]'::jsonb)
      into v_covers
      from ${qualified(ctx, "approval_delegations")} d
      where d.delegate = v_user::${user}
        and d.delegator::text <> v_user
        and d."from" <= now()
        and now() < d."until"
        and d.permissions is null;
    end if;
    if jsonb_array_length(v_covers) = 0 then
      continue;
    end if;
${member}
    for v_delegator in
      select (c ->> 'delegator')::${user}
      from jsonb_array_elements(v_covers) c
      where c ->> 'delegator' <> v_request ->> 'requester'
        and (c ->> 'within' is null or c ->> 'within' = v_request ->> 'within')
        and (c ->> 'resources' is null or c -> 'resources' ? (v_request ->> 'resource'))
    loop
      if ${qualified(ctx, COVER_APPROVES)}(v_delegator, v_request -> 'approvers', v_request ->> 'within', v_request ->> 'requester') then
        return next v_request ->> 'id';
        exit;
      end if;
    end loop;`
    : "";
  const coverDeclarations = options.delegations
    ? `
  v_covers jsonb;
  v_member text[];
  v_delegator ${user};`
    : "";
  return `
-- approvers as a set: permdock_is_approver over the facts permdock_approver_request_ids read once; only it calls this
create or replace function ${matches}(p_approvers jsonb, p_tenant text, p_requester text, p_user text, p_facts jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_item jsonb;${options.managers ? "\n  v_levels jsonb;" : ""}
begin
  if p_approvers is null then
    return false;
  end if;
  if jsonb_typeof(p_approvers) = 'array' then
    if jsonb_array_length(p_approvers) = 0 then
      return false;
    end if;
    for v_item in select value from jsonb_array_elements(p_approvers) loop
      if not ${matches}(v_item, p_tenant, p_requester, p_user, p_facts) then
        return false;
      end if;
    end loop;
    return true;
  end if;
  if jsonb_typeof(p_approvers) <> 'object' then
    return false;
  end if;
  case p_approvers ->> 'kind'
    when 'user' then
      return coalesce(p_approvers ->> 'id' = p_user, false);
    when 'permission' then
      if p_tenant is null then
        return coalesce((p_facts -> 'global' ->> (p_approvers ->> 'permission'))::boolean, false);
      end if;
      return coalesce(p_facts -> 'within' -> (p_approvers ->> 'permission') ? p_tenant, false);${managerCase}
    when 'any-of' then
      if jsonb_typeof(p_approvers -> 'of') <> 'array' then
        return false;
      end if;
      for v_item in select value from jsonb_array_elements(p_approvers -> 'of') loop
        if ${matches}(v_item, p_tenant, p_requester, p_user, p_facts) then
          return true;
        end if;
      end loop;
      return false;
    else
      return false;
  end case;
end;
$$;
revoke execute on function ${matches}(jsonb, text, text, text, jsonb) from public, anon, authenticated;

-- approvers as a set: the ids in p_requests ({ id, kind, tenant, requester, approvers }) the signed-in user may approve, each as permdock_is_approver answers it; a policy calls it uncorrelated, once per statement
create or replace function ${fn}(p_requests jsonb, p_kinds jsonb, p_current boolean default false)
returns setof text
language plpgsql
stable
security definer
rows 10
set search_path = ''
as $$
declare
  v_user text := ${subjectIdSql(ctx)}::text;
  v_requests jsonb;
  v_request jsonb;
  v_facts jsonb;${coverDeclarations}
begin
  if coalesce(v_user, '') = '' or jsonb_typeof(p_requests) is distinct from 'array' then
    return;
  end if;
  if jsonb_array_length(p_requests) > ${String(MAX_APPROVER_REQUESTS)} then
    raise exception using
      errcode = '54000',
      hint = 'pass at most ${String(MAX_APPROVER_REQUESTS)} requests per call, for example one page of the list',
      message = 'permdock: permdock_approver_request_ids takes at most ${String(MAX_APPROVER_REQUESTS)} requests, got ' || jsonb_array_length(p_requests);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id,
      'within', r.within,
      'requester', r.requester,
      'resource', r.resource,
      'approvers', ${approvers}
    )), '[]'::jsonb)
  into v_requests
  from (
    select e ->> 'id' as id,
      e ->> 'tenant' as within,
      e ->> 'requester' as requester,
      case when k.listed then ${resource} else split_part(e ->> 'kind', '.', 1) end as resource,
      case when k.listed then p_kinds -> (e ->> 'kind') end as approvers,
      e -> 'approvers' as current,
      k.listed
    from jsonb_array_elements(p_requests) e,
      lateral (select coalesce(${listed}, false) as listed) k
    where jsonb_typeof(e) = 'object' and e ->> 'id' is not null
  ) r
  where ${kept};
  if jsonb_array_length(v_requests) = 0 then
    return;
  end if;
  with leaves as (
    select r ->> 'within' as within, l ->> 'permission' as permission
    from jsonb_array_elements(v_requests) r, jsonb_path_query(r -> 'approvers', 'strict $.** ? (@.kind == "permission")') l
  )${managerLeaves}
  select jsonb_build_object(
    'global', (
      select coalesce(jsonb_object_agg(p.permission, coalesce(${qualified(ctx, PERMISSION_HELPERS.has)}(p.permission), false)), '{}'::jsonb)
      from (select distinct l.permission from leaves l where l.within is null and l.permission is not null) p
    ),
    'within', ${tenantFacts}${managerFacts}
  )
  into v_facts;
  for v_request in select value from jsonb_array_elements(v_requests) loop
    if ${matches}(v_request -> 'approvers', v_request ->> 'within', v_request ->> 'requester', v_user, v_facts) then
      return next v_request ->> 'id';
      continue;
    end if;${covers}
  end loop;
end;
$$;
revoke execute on function ${fn}(jsonb, jsonb, boolean) from public, anon;
grant execute on function ${fn}(jsonb, jsonb, boolean) to authenticated;
`;
}
