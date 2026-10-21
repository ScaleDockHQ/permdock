import type { RlsMembershipTable } from "../types.ts";
import type { RlsSqlContext } from "./context.ts";

import { byCodePoint } from "../../core/compare.ts";
import { configError } from "../core/errors.ts";
import { tenantTypeOf } from "./columns.ts";
import { CLAIM } from "./context.ts";
import { qualified, quoteIdent, quoteLiteral } from "./quote.ts";

/**
 * A role with `for` counts only on a membership of one of those kinds: `case
 * role when 'admin' then via = any(...) ... else true end`. A missing kind
 * (`viaExpr` null) holds none of them. A constant kind folds into the roles it
 * excludes, or no filter. `undefined` when nothing is filtered.
 */
export function kindFilterSql(
  ctx: RlsSqlContext,
  roleExpr: string,
  viaExpr: MemberVia,
): string | undefined {
  const kinds = Object.entries(ctx.ownership?.kinds ?? {}).toSorted(
    ([a], [b]) => byCodePoint(a, b),
  );
  if (kinds.length === 0) {
    return undefined;
  }
  if (typeof viaExpr !== "string") {
    const excluded = kinds
      .filter(([, allowed]) => !viaAllowed(viaExpr.value, allowed))
      .map(([role]) => role);
    return excluded.length === 0
      ? undefined
      : `not (${roleExpr} = any(array[${excluded.map(quoteLiteral).join(", ")}]::text[]))`;
  }
  const arms = kinds.map(
    ([role, allowed]) =>
      `when ${quoteLiteral(role)} then coalesce(${viaExpr}, '') = any(array[${allowed.map(quoteLiteral).join(", ")}]::text[])`,
  );
  return `case ${roleExpr} ${arms.join(" ")} else true end`;
}

/**
 * The kind check for one known role; `undefined` when it has no `for` or a
 * constant kind it allows.
 */
export function roleKindSql(
  ctx: RlsSqlContext,
  role: string,
  viaExpr: MemberVia,
): string | undefined {
  const allowed = ctx.ownership?.kinds[role];
  if (allowed === undefined) {
    return undefined;
  }
  if (typeof viaExpr !== "string") {
    return viaAllowed(viaExpr.value, allowed) ? undefined : "false";
  }
  return `coalesce(${viaExpr}, '') = any(array[${allowed.map(quoteLiteral).join(", ")}]::text[])`;
}

/** Roles with `for` held globally (no membership, so no kind) grant nothing. */
export function globalKindFilterSql(
  ctx: RlsSqlContext,
  roleExpr: string,
): string | undefined {
  const roles = Object.keys(ctx.ownership?.kinds ?? {}).toSorted();
  return roles.length === 0
    ? undefined
    : `not (${roleExpr} = any(array[${roles.map(quoteLiteral).join(", ")}]::text[]))`;
}

export function keyTenantSql(
  ctx: RlsSqlContext,
  tenant: string | undefined,
): string | undefined {
  const keys = ctx.apiKeys;
  if (keys === undefined) {
    return undefined;
  }
  const named = `nullif(${subjectClaimJsonSql(ctx, keys.claim)} ->> ${quoteLiteral(keys.tenant)}, '')`;
  return tenant === undefined
    ? `${named} is null`
    : `(${named} is null or (${tenant})::text = ${named})`;
}

/**
 * The active-tenant claim cast to the tenant column's type, so the comparison
 * uses the column's index.
 */
export function tenantClaimSql(ctx: RlsSqlContext): string {
  return `${subjectClaimSql(ctx, ctx.tenantClaim)}::${tenantTypeOf(ctx)}`;
}

export const USER_ID_HELPER = "permdock_user_id";

export function userIdHelperSql(ctx: Pick<RlsSqlContext, "schema">): string {
  return qualified(ctx, USER_ID_HELPER);
}

export const SESSION_LIVE_HELPER = "permdock_session_live";

/**
 * `{ subject: { session: { live: true } } }` in a policy; only Supabase has
 * `auth.sessions`.
 */
export function liveSessionSql(ctx: RlsSqlContext): string {
  if (ctx.dialect !== "supabase") {
    throw configError(
      `PermDock CLI: { subject: { session: { live: true } } } reads auth.sessions, which only the supabase dialect has (got ${ctx.dialect})`,
    );
  }
  return `(select ${qualified(ctx, SESSION_LIVE_HELPER)}())`;
}

/**
 * `permdock_session_live()`: the token's `session_id` names a session of its
 * user that is still in `auth.sessions`, so a signed-out or revoked session
 * stops passing before the token's `exp`. A token without one, such as a
 * service key's, is never live.
 */
export function sessionLiveHelperSql(ctx: RlsSqlContext): string {
  const name = qualified(ctx, SESSION_LIVE_HELPER);
  return `create or replace function ${name}()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session uuid;
begin
  begin
    v_session := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  if v_session is null then
    return false;
  end if;
  return exists (
    select 1
    from auth.sessions s
    where s.id = v_session
      and s.user_id::text = ${subjectIdSql(ctx)}::text
      and (s.not_after is null or s.not_after > now())
  );
end;
$$;
revoke execute on function ${name}() from public, anon;
grant execute on function ${name}() to authenticated;
`;
}

export function subjectIdSql(ctx: RlsSqlContext): string {
  if (ctx.subjectId !== undefined) {
    return ctx.subjectId;
  }
  switch (ctx.dialect) {
    case "supabase":
      return `(select ${userIdHelperSql(ctx)}())`;
    case "neon":
      return "(select auth.user_id())";
    case "guc":
      return `(select current_setting(${quoteLiteral(`${ctx.gucPrefix}.user_id`)}, true))`;
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

export function subjectClaimSql(ctx: RlsSqlContext, claim: string): string {
  if (!CLAIM.test(claim)) {
    throw configError(`PermDock CLI: unsafe claim name '${claim}'`);
  }
  switch (ctx.dialect) {
    case "supabase":
      return `((select auth.jwt()) ->> ${quoteLiteral(claim)})`;
    case "neon":
      return `((select auth.session()) ->> ${quoteLiteral(claim)})`;
    case "guc":
      return `(select current_setting(${quoteLiteral(`${ctx.gucPrefix}.${claim}`)}, true))`;
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

/** A claim as `jsonb`; the `guc` dialect stores JSON text in `<prefix>.<claim>`. */
export function subjectClaimJsonSql(ctx: RlsSqlContext, claim: string): string {
  if (!CLAIM.test(claim)) {
    throw configError(`PermDock CLI: unsafe claim name '${claim}'`);
  }
  switch (ctx.dialect) {
    case "supabase":
      return `((select auth.jwt()) -> ${quoteLiteral(claim)})`;
    case "neon":
      return `((select auth.session()) -> ${quoteLiteral(claim)})`;
    case "guc":
      return `nullif((select current_setting(${quoteLiteral(`${ctx.gucPrefix}.${claim}`)}, true)), '')::jsonb`;
    default: {
      const exhaustive: never = ctx.dialect;
      return exhaustive;
    }
  }
}

/**
 * The membership kind of a row: SQL for a column (or a claim entry), or the
 * value every row of the table has, `null` when the table has no kind.
 */
export type MemberVia = string | { readonly value: string | null };

function viaAllowed(value: string | null, allowed: readonly string[]): boolean {
  return allowed.includes(value ?? "");
}

/**
 * The membership kind of a row `m` of `table`: its column as text, or its
 * constant (`null` without one).
 */
export function memberVia(table: RlsMembershipTable): MemberVia {
  const via = table.via;
  if (via === undefined) {
    return { value: null };
  }
  return typeof via === "string"
    ? `m.${quoteIdent(via)}::text`
    : { value: via.value };
}
