import type {
  ApiKeysPlan,
  CheckedPermission,
  RlsSqlContext,
} from "./rls-sql.ts";
import type { RlsApiKeys } from "./types.ts";

import { SQL_IDENT } from "../core/sql.ts";
import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";
import {
  activeInstancesSql,
  grantPermissionSql,
  kindFilterSql,
  quoteIdent,
  quoteLiteral,
  subjectClaimJsonSql,
  subjectIdSql,
} from "./rls-sql.ts";

export const API_KEY_ALLOWS = "permdock_api_key_allows";

const DEFAULTS = {
  claim: "api_key",
  scopes: "scopes",
  tenant: "tenant",
  roles: "roles",
} as const;

function field(settings: RlsApiKeys, name: keyof typeof DEFAULTS): string {
  const value = settings[name] ?? DEFAULTS[name];
  if (typeof value !== "string" || !SQL_IDENT.test(value)) {
    throw new Error(
      `PermDock CLI: rls.apiKeys.${name} must be a claim field name matching ${SQL_IDENT.source}`,
    );
  }
  return value;
}

export function apiKeyFields(
  setting: true | RlsApiKeys,
): Omit<ApiKeysPlan, "renamed"> {
  const settings: RlsApiKeys = setting === true ? {} : setting;
  return {
    claim: field(settings, "claim"),
    scopes: field(settings, "scopes"),
    tenant: field(settings, "tenant"),
    roles: field(settings, "roles"),
    serviceRoles: [...new Set(settings.serviceRoles ?? [])],
  };
}

export function apiKeysPlan(
  setting: true | RlsApiKeys | undefined,
  declared: ReadonlySet<string>,
  renamed: Readonly<Record<string, string>>,
): ApiKeysPlan | undefined {
  if (setting === undefined) {
    return undefined;
  }
  const fields = apiKeyFields(setting);
  const unknown = fields.serviceRoles.filter((role) => !declared.has(role));
  if (unknown.length > 0) {
    throw new Error(
      `PermDock CLI: rls.apiKeys.serviceRoles names roles the policy does not declare: ${unknown.join(", ")}`,
    );
  }
  return {
    ...fields,
    ...(Object.keys(renamed).length === 0 ? {} : { renamed }),
  };
}

function qualified(ctx: RlsSqlContext, name: string): string {
  return `${quoteIdent(ctx.schema ?? PERMDOCK_SCHEMA)}.${name}`;
}

function keyOf(ctx: RlsSqlContext, plan: ApiKeysPlan): string {
  return `(select ${subjectClaimJsonSql(ctx, plan.claim)} as k) api_key`;
}

function permissionOf(plan: ApiKeysPlan, expr: string): string {
  return plan.renamed === undefined
    ? expr
    : `coalesce(${quoteLiteral(JSON.stringify(plan.renamed))}::jsonb ->> ${expr}, ${expr})`;
}

export function apiKeyAllowsCall(ctx: RlsSqlContext, grant: string): string {
  return `${qualified(ctx, API_KEY_ALLOWS)}(${grant})`;
}

export function apiKeyAllowsSql(
  ctx: RlsSqlContext,
  plan: ApiKeysPlan,
  anonExecute: boolean,
): string {
  const fn = qualified(ctx, API_KEY_ALLOWS);
  const scopes = `k -> ${quoteLiteral(plan.scopes)}`;
  const grants = anonExecute
    ? `revoke execute on function ${fn}(text) from public;
grant execute on function ${fn}(text) to anon, authenticated;`
    : `revoke execute on function ${fn}(text) from public, anon;
grant execute on function ${fn}(text) to authenticated;`;
  return `-- API keys: the ${plan.claim} claim's ${plan.scopes} list is a ceiling on every allow; denies always apply, and a request without the claim is not limited
create or replace function ${fn}(p_grant text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when k is null or k = 'null'::jsonb then true
    when exists (
      select 1 from ${qualified(ctx, "role_permissions")} rp
      where rp.grant_key = p_grant and rp.effect = 'deny'
    ) then true
    when jsonb_typeof(k) is distinct from 'object' or jsonb_typeof(${scopes}) is distinct from 'array' then false
    else exists (
      select 1
      from jsonb_array_elements_text(${scopes}) s(permission)
      where ${permissionOf(plan, "s.permission")} = split_part(split_part(p_grant, '#', 1), '@', 1)
    )
  end
  from ${keyOf(ctx, plan)}
$$;
${grants}`;
}

function serviceRolesJson(plan: ApiKeysPlan): string {
  return `${quoteLiteral(JSON.stringify(plan.serviceRoles))}::jsonb`;
}

function serviceKeyRows(ctx: RlsSqlContext, plan: ApiKeysPlan): string {
  const roles = `k -> ${quoteLiteral(plan.roles)}`;
  return `  from ${keyOf(ctx, plan)}
  cross join lateral jsonb_array_elements_text(
    case jsonb_typeof(${roles}) when 'array' then ${roles} else ${serviceRolesJson(plan)} end
  ) r(role)`;
}

function serviceKeyFilters(
  ctx: RlsSqlContext,
  plan: ApiKeysPlan,
  root: string,
  permission?: CheckedPermission,
): string[] {
  const tenant = `k ->> ${quoteLiteral(plan.tenant)}`;
  return [
    `jsonb_typeof(k) = 'object'`,
    `coalesce(${subjectIdSql(ctx)}::text, '') = ''`,
    `coalesce(${tenant}, '') <> ''`,
    ...activeInstancesSql(
      ctx,
      root,
      (name) => (name === root ? tenant : undefined),
      permission,
    ),
  ];
}

export function serviceKeyIdsSql(
  ctx: RlsSqlContext,
  plan: ApiKeysPlan,
  root: string,
  type: string,
): string {
  const kind = kindFilterSql(ctx, "r.role", { value: "credential" });
  const set = ctx.grantSet === true;
  const filters = [
    ...serviceKeyFilters(
      ctx,
      plan,
      root,
      grantPermissionSql(set ? "rp.grant_key" : "p_grant"),
    ),
    ...(set ? [] : ["rp.grant_key = p_grant"]),
    `rp.scope = ${quoteLiteral(root)}`,
    ...(kind === undefined ? [] : [kind]),
  ];
  return `  select (k ->> ${quoteLiteral(plan.tenant)})::${type}${set ? ", rp.grant_key" : ""}
${serviceKeyRows(ctx, plan)}
  join ${qualified(ctx, "role_permissions")} rp on rp.role = r.role
  where ${filters.join("\n    and ")}`;
}

export function serviceKeyMemberSql(
  ctx: RlsSqlContext,
  plan: ApiKeysPlan,
  root: string,
  type: string,
): string {
  return `  select distinct (k ->> ${quoteLiteral(plan.tenant)})::${type}
${serviceKeyRows(ctx, plan)}
  where ${serviceKeyFilters(ctx, plan, root).join("\n    and ")}`;
}

export function ceilingIdsSql(body: string, allows: string): string {
  return `  select ids.id
  from (
${body}
  ) ids(id)
  where ${allows}`;
}

export function ceilingHasSql(body: string, allows: string): string {
  return `  select ${allows} and coalesce((
${body}
  ), false)`;
}
