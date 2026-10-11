import type { CheckedPermission, RlsSqlContext } from "../sql/context.ts";

import { activeInstancesSql, activeUserSql } from "../sql/active.ts";
import { type RoleRows, globalRoleSource } from "../sql/global-roles.ts";
import { qualified, quoteLiteral } from "../sql/quote.ts";
import { CUSTOM_ROLES } from "../sql/shared.ts";
import {
  keyTenantSql,
  subjectClaimJsonSql,
  subjectClaimSql,
} from "../sql/subject.ts";

export function activeTenant(ctx: RlsSqlContext): string {
  return `nullif(${subjectClaimSql(ctx, ctx.tenantClaim)}, '')`;
}

export function keyTenantLine(
  ctx: RlsSqlContext,
  scope: string,
  tenant: string,
): string {
  const keyed = keyTenantSql(ctx, underRoot(ctx, scope) ? tenant : undefined);
  return keyed === undefined ? "" : `\n    and ${keyed}`;
}

/** Whether the helper for `scope` narrows to the tenant claim: unless `rls.tenants` is `'all'`, when the first scope is on its chain. */
export function narrowsTo(ctx: RlsSqlContext, scope: string): boolean {
  return ctx.tenants !== "all" && underRoot(ctx, scope);
}

/** Whether the active tenant narrows memberships of `scope`: the first scope is on its chain. */
function underRoot(ctx: RlsSqlContext, scope: string): boolean {
  const root = ctx.scopes[0]?.name;
  let current = ctx.scopes.find((item) => item.name === scope);
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.name)) {
    if (current.name === root) {
      return true;
    }
    seen.add(current.name);
    const parent: string | undefined = current.within;
    current =
      parent === undefined
        ? undefined
        : ctx.scopes.find((item) => item.name === parent);
  }
  return false;
}

/** `and exists (...)` lines for an active user; empty without `rls.suspension.users`. */
export function userActive(
  ctx: RlsSqlContext,
  indent: string,
  user?: string,
): string[] {
  return activeUserSql(ctx, user).map((part) => `${indent}and ${part}`);
}

/** `and exists (...)` lines for every suspendable instance on the chain of `scope`'s membership. */
export function instancesActive(
  ctx: RlsSqlContext,
  scope: string,
  idOf: (name: string) => string | undefined,
  indent: string,
  permission?: CheckedPermission,
): string[] {
  return activeInstancesSql(ctx, scope, idOf, permission).map(
    (part) => `${indent}and ${part}`,
  );
}

export function roleRows(ctx: RlsSqlContext): string {
  const claim = ctx.roleClaim ?? "user_role";
  switch (ctx.dialect) {
    case "guc":
      return `unnest(string_to_array(nullif(current_setting(${quoteLiteral(`${ctx.gucPrefix}.${claim}`)}, true), ''), ',')) r(role)`;
    case "supabase":
    case "neon": {
      const raw = subjectClaimJsonSql(ctx, claim);
      // A top-level null falls back to app_metadata, like subjectFromSupabase.
      const value =
        ctx.dialect === "supabase"
          ? `coalesce(nullif(${raw}, 'null'::jsonb), (select auth.jwt()) -> 'app_metadata' -> ${quoteLiteral(claim)})`
          : raw;
      return `jsonb_array_elements_text(
      case jsonb_typeof(${value})
        when 'array' then ${value}
        when 'string' then jsonb_build_array(${value})
        else '[]'::jsonb
      end
    ) r(role)`;
    }
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

export function membershipRows(ctx: RlsSqlContext): string {
  const raw = subjectClaimJsonSql(ctx, "memberships");
  const value =
    ctx.dialect === "supabase"
      ? `coalesce(${raw}, (select auth.jwt()) -> 'app_metadata' -> 'memberships')`
      : raw;
  return `jsonb_array_elements(
      case jsonb_typeof(${value}) when 'array' then ${value} else '[]'::jsonb end
    ) m
    cross join lateral jsonb_array_elements_text(
      case jsonb_typeof(m -> 'roles') when 'array' then m -> 'roles' else '[]'::jsonb end
    ) r(role)`;
}

export function andLine(indent: string, condition: string | undefined): string {
  return condition === undefined ? "" : `\n${indent}and ${condition}`;
}

/** `rls.roles`, or the generated `user_roles (user_id, role)`, aliased `ur`. */
export function globalRoleRows(
  ctx: RlsSqlContext,
): Pick<RoleRows, "from" | "userSql" | "roleSql"> {
  return ctx.roles === undefined
    ? {
        from: `${qualified(ctx, "user_roles")} ur`,
        userSql: "ur.user_id",
        roleSql: "ur.role::text",
      }
    : globalRoleSource(ctx.roles, "public", "ur", ctx.customRoles?.table);
}

export function customKeysJoin(
  ctx: RlsSqlContext,
  scope: string,
  allows: string,
  denies: string,
  includes: string,
): string {
  return `  cross join lateral ${qualified(ctx, CUSTOM_ROLES.keys)}(
    ${allows},
    ${denies},
    ${includes},
    ${quoteLiteral(scope)}
  ) ck(grant_key)`;
}
