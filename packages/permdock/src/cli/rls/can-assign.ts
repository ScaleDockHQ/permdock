import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type { RlsOwnership, RlsSqlContext } from "../sql/context.ts";

import { tenantTypeOf } from "../sql/columns.ts";
import { memberRoleOf, scopeSources, scopeTable } from "../sql/names.ts";
import {
  declaredArray,
  qualified,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { signedIn } from "../sql/shared.ts";
import {
  globalKindFilterSql,
  kindFilterSql,
  memberVia,
  subjectIdSql,
} from "../sql/subject.ts";
import { hasCustomRoleChecksFor } from "./custom-roles.ts";
import {
  claimKeptLines,
  disabledColumn,
  memberColumn,
  sourceFilters,
  sourcesKeep,
} from "./helper-bodies.ts";
import { globalRoleRows, membershipRows, roleRows } from "./helper-rows.ts";
import { ASSIGNMENTS, OWNERSHIP } from "./ownership-names.ts";
import { pairsSql, sourceRowsSql } from "./ownership-sources.ts";

/** Whether the signed-in user (or `p_user` in the `_for` form) holds, in instance `p_scope_id`, a role whose `assigns` lists `p_role`. */
export function canAssignSql(
  base: RlsSqlContext,
  own: RlsOwnership,
  forUser = false,
): string {
  const ctx: RlsSqlContext = forUser
    ? { ...base, subjectId: "p_user", tenants: "all" }
    : base;
  const fn = qualified(
    ctx,
    forUser ? OWNERSHIP.canAssignFor : OWNERSHIP.canAssign,
  );
  const parts: string[] = [];
  const used: SqlMembershipSource[] = [];
  const userOf = (source: SqlMembershipSource): string => {
    const index = used.includes(source)
      ? used.indexOf(source)
      : used.push(source) - 1;
    return `v_user_${String(index)}`;
  };
  const global = own.assigns.filter((pair) => pair.scope === "global");
  for (const [instance, pairs] of [
    ["p_scope_id is not null", global.filter((pair) => pair.at !== "global")],
    ["p_scope_id is null", global.filter((pair) => pair.at === "global")],
  ] as const) {
    if (pairs.length === 0) {
      continue;
    }
    if (ctx.authorize === "database") {
      const ur = globalRoleRows(ctx);
      const kind = globalKindFilterSql(ctx, ur.roleSql);
      parts.push(`${instance} and exists (
      select 1 from ${ur.from}
      where ${ur.userSql} = ${subjectIdSql(ctx)}
        and (${ur.roleSql}, p_role) in (${pairsSql(pairs)})${kind === undefined ? "" : `\n        and ${kind}`}
    )`);
    } else {
      const kind = globalKindFilterSql(ctx, "r.role");
      parts.push(`${instance} and exists (
      select 1 from ${roleRows(ctx)}
      where (r.role, p_role) in (${pairsSql(pairs)})${kind === undefined ? "" : `\n        and ${kind}`}
    )`);
    }
  }
  for (const { name } of ctx.scopes) {
    const pairs = own.assigns.filter((pair) => pair.scope === name);
    if (pairs.length === 0) {
      continue;
    }
    const sources = scopeSources(ctx, name);
    if (sources.length > 0) {
      const kind = kindFilterSql(ctx, "r.role", "ms.via");
      parts.push(`exists (
      select 1
      from (
${sourceRowsSql(sources, userOf)}
      ) ms
      cross join lateral jsonb_array_elements_text(
        case jsonb_typeof(ms.roles) when 'array' then ms.roles else '[]'::jsonb end
      ) r(role)
      where ms.scope = ${quoteLiteral(name)}
        and ms.id = p_scope_id
        and (r.role, p_role) in (${pairsSql(pairs)})${kind === undefined ? "" : `\n        and ${kind}`}${sourceFilters(ctx, name, undefined, undefined, sourcesKeep(sources)).replaceAll("\n    and ", "\n        and ")}
    )`);
      continue;
    }
    if (ctx.authorize === "database") {
      const mapped = scopeTable(ctx, name);
      if (mapped === undefined) {
        continue;
      }
      const { table, column } = mapped;
      const role = memberRoleOf(table, "m", "      ");
      const filters = [
        `${memberColumn(table.user)} = ${subjectIdSql(ctx)}`,
        `${memberColumn(column)}::text = p_scope_id`,
        `(${role.sql}, p_role) in (${pairsSql(pairs)})`,
      ];
      if (table.expiresAt !== undefined) {
        const expires = memberColumn(table.expiresAt);
        filters.push(`(${expires} is null or ${expires} > now())`);
      }
      const disabled = disabledColumn(table);
      if (disabled !== undefined) {
        filters.push(`${disabled} is null`);
      }
      const kind = kindFilterSql(ctx, role.sql, memberVia(table));
      if (kind !== undefined) {
        filters.push(kind);
      }
      parts.push(`exists (
      select 1 from ${quoteQualified(table.table)} m${role.join}
      where ${filters.join("\n        and ")}
    )`);
    } else {
      const kind = kindFilterSql(ctx, "r.role", "m ->> 'via'");
      parts.push(`exists (
      select 1 from ${membershipRows(ctx)}
      where m ->> 'scope' = ${quoteLiteral(name)}
        and m ->> 'id' = p_scope_id
        and (r.role, p_role) in (${pairsSql(pairs)})
        and case jsonb_typeof(m -> 'expires_at')
          when 'number' then (m ->> 'expires_at')::numeric > extract(epoch from now())
          else true
        end${kind === undefined ? "" : `\n        and ${kind}`}${claimKeptLines(
          ctx,
          "        ",
        )
          .map((line) => `\n${line}`)
          .join("")}
    )`);
    }
  }
  const body = parts.length === 0 ? "false" : parts.join("\n    or ");
  const language =
    used.length === 0
      ? `language sql
stable
security definer
set search_path = ''
as $$
  select ${signedIn(ctx)} and (
    ${body}
  )
$$;`
      : `language plpgsql
stable
security definer
set search_path = ''
as $$
declare
${used.map((source, index) => `  v_user_${String(index)} ${source.sql.userType} := ${subjectIdSql(ctx)};`).join("\n")}
begin
  return ${signedIn(ctx)} and (
    ${body}
  );
end;
$$;`;
  if (forUser) {
    const user = ctx.dialect === "supabase" ? "uuid" : "text";
    return `-- who may assign, for a user the caller names: trusted SQL acting later for a stored user; no client role may execute it
create or replace function ${fn}(p_user ${user}, p_role text, p_scope_id text)
returns boolean
${language}
revoke execute on function ${fn}(${user}, text, text) from public, anon, authenticated;`;
  }
  return `-- who may assign: a held role whose assigns lists p_role, in instance p_scope_id (its scope or an ancestor's); a null p_scope_id assigns a global role, which only global assigners may
create or replace function ${fn}(p_role text, p_scope_id text)
returns boolean
${language}
revoke execute on function ${fn}(text, text) from public, anon;
grant execute on function ${fn}(text, text) to authenticated;`;
}

/** Whether the helpers keep custom roles in tables, so assigning one is checked against its stored definition. */
export function assignsCustomRoles(ctx: RlsSqlContext): boolean {
  return ctx.customRoles !== undefined && ctx.authorize === "database";
}

/** Whether `permdock_can_assign_any_for` is written: every function it calls has a `_for` form. */
export function hasCanAssignAnyFor(ctx: RlsSqlContext): boolean {
  return (
    ctx.authorize === "database" &&
    (!assignsCustomRoles(ctx) || hasCustomRoleChecksFor(ctx))
  );
}

/**
 * `permdock_can_assign_any`: one check for a declared or a custom role, so
 * SQL that assigns roles calls one function: `permdock_can_assign` for a
 * declared role, `permdock_can_assign_custom_role` for a custom one. `p_scope`
 * `'global'` (no tenant, no instance) assigns a platform role.
 */
export function canAssignAnySql(
  ctx: RlsSqlContext,
  custom: boolean,
  forUser = false,
): string {
  const tenantType = tenantTypeOf(ctx);
  const fn = qualified(
    ctx,
    forUser ? OWNERSHIP.canAssignAnyFor : OWNERSHIP.canAssignAny,
  );
  const declaredFn = qualified(
    ctx,
    forUser ? OWNERSHIP.canAssignFor : OWNERSHIP.canAssign,
  );
  const customFn = qualified(
    ctx,
    forUser ? ASSIGNMENTS.customFor : ASSIGNMENTS.custom,
  );
  const userType = ctx.dialect === "supabase" ? "uuid" : "text";
  const userParam = forUser ? `p_user ${userType}, ` : "";
  const userArg = forUser ? `${userType}, ` : "";
  const user = forUser ? "p_user, " : "";
  const declared = `${declaredFn}(${user}p_role, case when p_scope = 'global' then null else p_scope_id end)`;
  const body =
    custom && ctx.customRoles !== undefined
      ? `case
    when p_role = any(${declaredArray(ctx.customRoles.declared)}) then ${declared}
    when p_scope = 'global' then ${customFn}(${user}null, 'global', null, p_role)
    else ${customFn}(${user}p_tenant, p_scope, p_scope_id, p_role)
  end`
      : declared;
  const grants = forUser
    ? `revoke execute on function ${fn}(${userArg}text, ${tenantType}, text, text) from public, anon, authenticated;`
    : `revoke execute on function ${fn}(text, ${tenantType}, text, text) from public, anon;
grant execute on function ${fn}(text, ${tenantType}, text, text) to authenticated;`;
  return `-- whether ${forUser ? "user p_user" : "the caller"} may assign p_role at instance p_scope_id of p_scope in tenant p_tenant, declared or custom (p_scope 'global' for a platform role)${forUser ? "; no client role may execute it" : ""}
create or replace function ${fn}(${userParam}p_role text, p_tenant ${tenantType}, p_scope text, p_scope_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(${body}, false)
$$;
${grants}`;
}
