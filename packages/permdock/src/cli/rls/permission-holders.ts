import type { RlsSqlContext } from "../sql/context.ts";

import { scopeTypeOf } from "../sql/columns.ts";
import { hasPermittedUsers, scopeTable } from "../sql/names.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { holderBody } from "./helper-bodies.ts";
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

/**
 * The global-role holders kept in one statement: each holder's global grant
 * keys, read by the body `permdock_has_permission_for` reads, joined to the
 * permission's global allow and deny keys. `undefined` when that body needs
 * PL/pgSQL variables, which a lateral subquery cannot declare.
 */
function globalHoldersSql(
  ctx: RlsSqlContext,
  user: string,
): string | undefined {
  const has = grantBodies({
    ...forUserContext(ctx),
    subjectId: "pdk_u.user_id",
    grantSet: true,
  }).has;
  if (has.vars.length > 0) {
    return undefined;
  }
  const global = globalRoleRows(ctx);
  return `  pdk_g(user_id, grant_key) as (
    select pdk_u.user_id, pdk_k.grant_key
    from (
      select distinct ${global.userSql}::${user}
      from ${global.from}
      where ${global.userSql} is not null
    ) pdk_u(user_id)
    cross join lateral (
${indent(has.sql, "    ")}
    ) pdk_k(grant_key)
  )`;
}

/**
 * The holders on `p_id` in one statement: each member's grant keys there, from
 * the membership table, its declared roles and its compiled custom roles, kept
 * when one is an allow of the permission and none a deny, plus the global-role
 * holders kept by the same rule over their global grant keys.
 */
function setHoldersSql(
  ctx: RlsSqlContext,
  scope: string,
  holders: string,
  user: string,
): string {
  const keys = qualified(ctx, PERMISSION_HELPERS.grantKeys);
  const global = globalRoleRows(ctx);
  const hasFor = qualified(ctx, PERMISSION_HELPERS.hasFor);
  const at = (on: string, effect: string): string =>
    `(select g.grant_key from ${keys}(p_permission, ${on}${effect}) g(grant_key))`;
  const globalKeys = globalHoldersSql(ctx, user);
  const globals =
    globalKeys === undefined
      ? `  select ${global.userSql}::${user}
  from ${global.from}
  where ${global.userSql} is not null
    and ${hasFor}(${global.userSql}::${user}, p_permission)`
      : `  (select gh.user_id from pdk_g gh
  where gh.grant_key in ${at("'global'", "")}
  except
  select gh.user_id from pdk_g gh
  where gh.grant_key in ${at("'global'", ", 'deny'")})`;
  return `  with pdk_h(user_id, grant_key) as (
${holders}
  )${globalKeys === undefined ? "" : `,\n${globalKeys}`}
  select h.user_id from pdk_h h
  where h.user_id is not null
    and h.grant_key in ${at(quoteLiteral(scope), "")}
  except
  select h.user_id from pdk_h h
  where h.grant_key in ${at(quoteLiteral(scope), ", 'deny'")}
  union
${globals}
  order by 1`;
}

/**
 * One `permitted_<scope>_users(p_permission, p_id)` per scope in `database`
 * mode: the users who hold a permission key on one instance, so denies, custom
 * roles, expiry and suspension apply as for the user. With the scope's
 * memberships in one table it is one set-based query over the instance's
 * membership rows; with membership sources it reads each candidate through
 * `permitted_<scope>_ids_by_permission_for` and keeps a global-role holder when
 * `permdock_has_permission_for` answers. It names other users, so no client
 * role may execute it, and a backend role needs its own grant.
 */
export function permissionHoldersSql(ctx: RlsSqlContext): string {
  if (ctx.authorize !== "database") {
    return "";
  }
  const user = ctx.dialect === "supabase" ? "uuid" : "text";
  const global = globalRoleRows(ctx);
  const hasFor = qualified(ctx, PERMISSION_HELPERS.hasFor);
  const named = { ...forUserContext(ctx), grantSet: true } as const;
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
    const holders = holderBody(named, name, user, "p_id");
    const query =
      holders === undefined
        ? `  select c.user_id
  from (
${candidates.sql}
    union
    select ${global.userSql}::${user}
    from ${global.from}
  ) c(user_id)
  where c.user_id is not null
    and (
      p_id in (select ${ids}(c.user_id, p_permission))
      or ${hasFor}(c.user_id, p_permission)
    )
  order by 1`
        : setHoldersSql(ctx, name, holders, user);
    return `-- the users who hold a permission on one ${name}: its members and the global-role holders for whom the _for helpers answer; no client role may execute it
create or replace function ${fn}(p_permission text, p_id ${type})
returns setof ${user}
${functionBody(holders === undefined ? candidates.keys : [], query)}
revoke execute on function ${fn}(text, ${type}) from public, anon, authenticated;`;
  });
  return `${chunks.join("\n\n")}\n`;
}
