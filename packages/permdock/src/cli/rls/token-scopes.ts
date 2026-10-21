import type { Policy } from "../../index.ts";
import type { RlsSqlContext, TokenScopesPlan } from "../sql/context.ts";

import { delegatedScopeMap } from "../../core/oauth-scopes.ts";
import { formerKeys } from "../../core/permission-leaf.ts";
import { listPermissions } from "../../index.ts";
import { qualified, quoteLiteral } from "../sql/quote.ts";
import { subjectClaimJsonSql, subjectClaimSql } from "../sql/subject.ts";

export const TOKEN_SCOPE_ALLOWS = "permdock_token_scope_allows";

/**
 * `rls.tokenScopes` as the SQL generator needs it, or `undefined` when it is
 * off.
 */
export function tokenScopesPlan(
  setting: boolean | undefined,
  policy: Policy,
): TokenScopesPlan | undefined {
  if (setting !== true) {
    return undefined;
  }
  const permissions = listPermissions(policy.permissions).map((leaf) => ({
    key: leaf.key,
    scope: leaf.scope,
    renamedFrom: formerKeys(leaf),
  }));
  return { scopes: delegatedScopeMap(permissions, policy.oauthScopes) };
}

export function tokenScopeAllowsCall(
  ctx: RlsSqlContext,
  grant: string,
): string {
  return `${qualified(ctx, TOKEN_SCOPE_ALLOWS)}(${grant})`;
}

/**
 * The token's scopes as rows of `s(scope)`: a space-separated string or,
 * outside `guc`, a JSON array.
 */
function tokenScopeRows(ctx: RlsSqlContext): string {
  if (ctx.dialect === "guc") {
    return `regexp_split_to_table(btrim(coalesce(${subjectClaimSql(ctx, "scope")}, '')), '\\s+') s(scope)`;
  }
  const scope = subjectClaimJsonSql(ctx, "scope");
  return `unnest(case jsonb_typeof(${scope})
      when 'string' then regexp_split_to_array(btrim(${scope} #>> '{}'), '\\s+')
      when 'array' then array(select jsonb_array_elements_text(${scope}))
      else '{}'::text[]
    end) s(scope)`;
}

/**
 * `permdock_token_scope_allows(p_grant)`: a delegated token (a `client_id`, or
 * an `act` that is not a support or impersonation session) reaches a grant key
 * only when one of its scopes maps to the key's permission. better-supabase's
 * `cap_allows` reads the same tokens the same way.
 */
export function tokenScopeAllowsSql(
  ctx: RlsSqlContext,
  plan: TokenScopesPlan,
  anonExecute: boolean,
): string {
  const fn = qualified(ctx, TOKEN_SCOPE_ALLOWS);
  const act = subjectClaimJsonSql(ctx, "act");
  const grants = anonExecute
    ? `revoke execute on function ${fn}(text) from public;
grant execute on function ${fn}(text) to anon, authenticated;`
    : `revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;`;
  return `-- Token scopes: a delegated token holds only the permissions its scope claim maps to; denies always apply, and a token without client_id or an agent act is not limited
create or replace function ${fn}(p_grant text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when coalesce(${subjectClaimSql(ctx, "client_id")}, '') = ''
      and (${act} is null
        or ${act} = 'null'::jsonb
        or (jsonb_typeof(${act}) = 'object'
          and ${act} ->> 'kind' in ('support', 'impersonation'))) then true
    when exists (
      select 1 from ${qualified(ctx, "role_permissions")} rp
      where rp.grant_key = p_grant and rp.effect = 'deny'
    ) then true
    else exists (
      select 1
      from ${tokenScopeRows(ctx)}
      where s.scope <> ''
        and coalesce(${quoteLiteral(JSON.stringify(plan.scopes))}::jsonb -> s.scope, '[]'::jsonb)
          ? split_part(split_part(p_grant, '#', 1), '@', 1)
    )
  end
$$;
${grants}`;
}
