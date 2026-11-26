import type { Policy, PolicyDelegation } from "../../index.ts";
import type {
  DelegatedKeys,
  RlsSqlContext,
  TokenScopesPlan,
} from "../sql/context.ts";

import { delegatedScopeMap } from "../../core/oauth-scopes.ts";
import { formerKeys } from "../../core/permission-leaf.ts";
import { listPermissions } from "../../index.ts";
import { IDENTITY_SCOPES } from "../../supabase/subject.ts";
import { qualified, quoteLiteral } from "../sql/quote.ts";
import { subjectClaimJsonSql, subjectClaimSql } from "../sql/subject.ts";

export const TOKEN_SCOPE_ALLOWS = "permdock_token_scope_allows";

const TOKEN_SCOPE_MAP = "permdock_token_scope_map";

const TOKEN_DELEGATION_MAP = "permdock_token_delegation_map";

type TokenScopesSetting = boolean | { readonly delegations?: boolean };

export function isTokenScopesSetting(
  value: unknown,
): value is TokenScopesSetting | undefined {
  if (value === undefined || typeof value === "boolean") {
    return true;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.entries(value).every(
    ([key, flag]) =>
      key === "delegations" &&
      (flag === undefined || typeof flag === "boolean"),
  );
}

/** Whether `rls.tokenScopes` turns the helpers' token narrowing on. */
export function tokenScopesOn(
  setting: TokenScopesSetting | undefined,
): boolean {
  return setting === true || (typeof setting === "object" && setting !== null);
}

/**
 * Delegations Postgres can decide from the token alone: to `oauth-client`, from
 * `authenticated()` only, without a validity window. Others hand over nothing
 * in SQL, so the token stays capped by its scopes.
 */
function delegatedKeys(
  delegations: readonly PolicyDelegation[] | undefined,
): DelegatedKeys {
  const all = new Set<string>();
  const clients = new Map<string, Set<string>>();
  let everyClient = false;
  for (const delegation of delegations ?? []) {
    const from = Array.isArray(delegation.from)
      ? delegation.from
      : [delegation.from];
    if (
      delegation.to.kind !== "oauth-client" ||
      delegation.to.client !== undefined ||
      delegation.validity !== undefined ||
      from.length === 0 ||
      !from.every(
        (grantee: { readonly kind: string }) =>
          grantee.kind === "authenticated",
      )
    ) {
      continue;
    }
    const id = delegation.to.id;
    let target = all;
    if (id === undefined) {
      everyClient = true;
    } else {
      target = clients.get(id) ?? new Set();
      clients.set(id, target);
    }
    for (const key of delegation.permissions) {
      target.add(key);
    }
  }
  return {
    ...(everyClient ? { all: [...all].toSorted() } : {}),
    clients: Object.fromEntries(
      [...clients].map(([id, set]) => [id, [...set].toSorted()]),
    ),
  };
}

/**
 * `rls.tokenScopes` as the SQL generator needs it, or `undefined` when it is
 * off.
 */
export function tokenScopesPlan(
  setting: TokenScopesSetting | undefined,
  policy: Policy,
): TokenScopesPlan | undefined {
  if (!tokenScopesOn(setting)) {
    return undefined;
  }
  const permissions = listPermissions(policy.permissions).map((leaf) => ({
    key: leaf.key,
    scope: leaf.scope,
    renamedFrom: formerKeys(leaf),
    meta: leaf.meta,
  }));
  const scopes = delegatedScopeMap(permissions, policy.oauthScopes);
  if (typeof setting !== "object" || setting.delegations !== true) {
    return { scopes };
  }
  return { scopes, delegated: delegatedKeys(policy.delegations) };
}

export function tokenScopeUnlimitedSql(ctx: RlsSqlContext): string {
  const act = subjectClaimJsonSql(ctx, "act");
  return `coalesce(${subjectClaimSql(ctx, "client_id")}, '') = ''
      and (${act} is null
        or ${act} = 'null'::jsonb
        or (jsonb_typeof(${act}) = 'object'
          and ${act} ->> 'kind' in ('support', 'impersonation')))`;
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
  const map = qualified(ctx, TOKEN_SCOPE_MAP);
  const grants = anonExecute
    ? `revoke execute on function ${fn}(text) from public;
grant execute on function ${fn}(text) to anon, authenticated;`
    : `revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;`;
  const delegationMap = qualified(ctx, TOKEN_DELEGATION_MAP);
  const client = subjectClaimSql(ctx, "client_id");
  const act = subjectClaimJsonSql(ctx, "act");
  const key = "split_part(split_part(p_grant, '#', 1), '@', 1)";
  const covered = `exists (
      select 1
      from ${tokenScopeRows(ctx)}
      where s.scope <> ''
        and coalesce(${map}() -> s.scope, '[]'::jsonb)
          ? ${key}
    )`;
  const identity = [...IDENTITY_SCOPES].map(quoteLiteral).join(", ");
  const delegated =
    plan.delegated === undefined
      ? ""
      : `
    when coalesce(${client}, '') <> ''
      and (${act} is null or ${act} = 'null'::jsonb)
      and (${delegationMap}() ? 'all'
        or ${delegationMap}() -> 'clients' ? ${client})
    then (coalesce(${delegationMap}() -> 'all', '[]'::jsonb)
        || coalesce(${delegationMap}() -> 'clients' -> ${client}, '[]'::jsonb))
        ? ${key}
      and (not exists (
          select 1
          from ${tokenScopeRows(ctx)}
          where s.scope <> '' and s.scope <> all (array[${identity}])
        )
        or ${covered})`;
  const delegationFunction =
    plan.delegated === undefined
      ? ""
      : `
create or replace function ${delegationMap}()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select ${quoteLiteral(JSON.stringify(plan.delegated))}::jsonb
$$;
revoke execute on function ${delegationMap}() from public, anon, authenticated;
`;
  return `create or replace function ${map}()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select ${quoteLiteral(JSON.stringify(plan.scopes))}::jsonb
$$;
revoke execute on function ${map}() from public, anon, authenticated;
${delegationFunction}
-- Token scopes: a delegated token holds only the permissions its scope claim maps to; denies always apply, and a token without client_id or an agent act is not limited
create or replace function ${fn}(p_grant text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return (
  select case
    when ${tokenScopeUnlimitedSql(ctx)} then true
    when exists (
      select 1 from ${qualified(ctx, "role_permissions")} rp
      where rp.grant_key = p_grant and rp.effect = 'deny'
    ) then true${delegated}
    else ${covered}
  end
  );
end;
$$;
${grants}`;
}
