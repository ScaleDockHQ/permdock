import type { RlsSqlContext } from "../sql/context.ts";

import { scopeTypeOf } from "../sql/columns.ts";
import { hasPermittedUsers, scopeTable } from "../sql/names.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { globalRoleRows } from "./helper-rows.ts";
import { forUserContext, grantBodies } from "./helpers.ts";
import { holderSources } from "./ownership-sources.ts";
import {
  PERMISSION_HELPERS,
  checkName,
  permittedByPermissionHelper,
} from "./permission-keys.ts";

/**
 * `permitted_<scope>_users(p_permission, p_id)`. Names are part of the SQL
 * contract.
 */
export function permittedUsersHelper(scope: string): string {
  return checkName(`permitted_${scope}_users`);
}

type Candidates = {
  readonly sql: string;
  /**
   * `v_key_<n> <table>.<column>%type`, one per source: `p_id` converted to each
   * source's id column type.
   */
  readonly keys: readonly string[];
};

/**
 * The users with a membership row on the instance `p_id`, or `undefined` when
 * the scope's memberships are not all in tables.
 */
function candidatesSql(
  ctx: RlsSqlContext,
  scope: string,
  user: string,
): Candidates | undefined {
  const mapped = scopeTable(ctx, scope);
  if (mapped !== undefined) {
    return {
      sql: `    select m.${quoteIdent(mapped.table.user)}::${user}
    from ${quoteQualified(mapped.table.table)} m
    where m.${quoteIdent(mapped.column)} = p_id`,
      keys: [],
    };
  }
  const sources = holderSources(ctx, scope);
  if (sources === undefined || sources === "not-tables") {
    return undefined;
  }
  return {
    sql: sources
      .map(
        (source, index) => `    select h.user_id::${user}
    from (
${source.holders.rows(scope, { id: `v_key_${String(index)}` }).replaceAll(/^/gmu, "      ")}
    ) h`,
      )
      .join("\n    union\n"),
    keys: sources.map(
      (source, index) => `v_key_${String(index)} ${source.holders.idType}`,
    ),
  };
}

/**
 * `language sql`, or PL/pgSQL when a source's id column needs `p_id` in a
 * `%type` variable.
 */
function functionBody(keys: readonly string[], query: string): string {
  if (keys.length === 0) {
    return `language sql
stable
security definer
set search_path = ''
as $$
${query}
$$;`;
  }
  return `language plpgsql
stable
security definer
set search_path = ''
as $$
declare
${keys.map((key) => `  ${key} := p_id;`).join("\n")}
begin
  return query
${query.replaceAll(/^/gmu, "  ")};
end
$$;`;
}

function indent(sql: string, by: string): string {
  return sql.replaceAll(/^/gmu, by);
}

function heldBy(global: boolean, effect: "allow" | "deny"): string {
  return `exists (select 1 from pdk_h where pdk_h.user_id = pdk_u.user_id and pdk_h.global = ${String(global)} and pdk_h.effect = '${effect}')`;
}

/**
 * One query over every candidate: the grant keys each holds on `p_id` and
 * globally, read by the same bodies as `permission_keys_for`, joined to the
 * allow and deny keys of `p_permission`. `undefined` when a body needs PL/pgSQL
 * variables, which a lateral subquery cannot declare.
 */
function heldSql(
  ctx: RlsSqlContext,
  scope: string,
  candidates: string,
): string | undefined {
  const bodies = grantBodies({
    ...forUserContext(ctx),
    subjectId: "pdk_u.user_id",
    grantSet: true,
  });
  const ids = bodies.ids(scope);
  if (ids.vars.length > 0 || bodies.has.vars.length > 0) {
    return undefined;
  }
  const keys = qualified(ctx, PERMISSION_HELPERS.grantKeys);
  const at = quoteLiteral(scope);
  return `  with pdk_u(user_id) as (
    select c.user_id
    from (
${candidates}
    ) c(user_id)
    where c.user_id is not null
  ),
  pdk_k(grant_key, global, effect) as (
    select g.grant_key, false, 'allow' from ${keys}(p_permission, ${at}) g(grant_key)
    union all
    select g.grant_key, false, 'deny' from ${keys}(p_permission, ${at}, 'deny') g(grant_key)
    union all
    select g.grant_key, true, 'allow' from ${keys}(p_permission, 'global') g(grant_key)
    union all
    select g.grant_key, true, 'deny' from ${keys}(p_permission, 'global', 'deny') g(grant_key)
  ),
  pdk_h(user_id, global, effect) as (
    select pdk_u.user_id, pdk_k.global, pdk_k.effect
    from pdk_u
    cross join lateral (
${indent(ids.sql, "    ")}
    ) pdk_i(id, grant_key)
    join pdk_k on pdk_k.grant_key = pdk_i.grant_key and not pdk_k.global
    where pdk_i.id = p_id
    union
    select pdk_u.user_id, pdk_k.global, pdk_k.effect
    from pdk_u
    cross join lateral (
${indent(bodies.has.sql, "    ")}
    ) pdk_g(grant_key)
    join pdk_k on pdk_k.grant_key = pdk_g.grant_key and pdk_k.global
  )
  select pdk_u.user_id
  from pdk_u
  where (${heldBy(false, "allow")}
      and not ${heldBy(false, "deny")})
    or (${heldBy(true, "allow")}
      and not ${heldBy(true, "deny")})
  order by 1`;
}

/**
 * One `permitted_<scope>_users(p_permission, p_id)` per scope in `database`
 * mode: the users who hold a permission key on one instance, read from the
 * scope's membership rows and the global-roles table and kept when
 * `permitted_<scope>_ids_by_permission_for` lists the instance or
 * `permdock_has_permission_for` answers, so denies, custom roles, expiry and
 * suspension apply as for the user. With membership tables it is one query over
 * the candidates' grant keys instead of two helper calls per candidate. It
 * names other users, so no client role may execute it, and a backend role needs
 * its own grant.
 */
export function permissionHoldersSql(ctx: RlsSqlContext): string {
  if (ctx.authorize !== "database") {
    return "";
  }
  const user = ctx.dialect === "supabase" ? "uuid" : "text";
  const global = globalRoleRows(ctx);
  const hasFor = qualified(ctx, PERMISSION_HELPERS.hasFor);
  const chunks = ctx.scopes.map(({ name }) => {
    const candidates = hasPermittedUsers(ctx, name)
      ? candidatesSql(ctx, name, user)
      : undefined;
    if (candidates === undefined) {
      return `-- ${name}: no memberships table or table source, so permitted_${name}_users is not written`;
    }
    const fn = qualified(ctx, permittedUsersHelper(name));
    const ids = qualified(
      ctx,
      checkName(`${permittedByPermissionHelper(name)}_for`),
    );
    const type = scopeTypeOf(ctx, name);
    const all = `${candidates.sql}
    union
    select ${global.userSql}::${user}
    from ${global.from}`;
    const query =
      heldSql(ctx, name, indent(all, "  ")) ??
      `  select c.user_id
  from (
${all}
  ) c(user_id)
  where c.user_id is not null
    and (
      p_id in (select ${ids}(c.user_id, p_permission))
      or ${hasFor}(c.user_id, p_permission)
    )
  order by 1`;
    return `-- the users who hold a permission on one ${name}: its members and the global-role holders for whom the _for helpers answer; no client role may execute it
create or replace function ${fn}(p_permission text, p_id ${type})
returns setof ${user}
${functionBody(candidates.keys, query)}
revoke execute on function ${fn}(text, ${type}) from public, anon, authenticated;`;
  });
  return `${chunks.join("\n\n")}\n`;
}
