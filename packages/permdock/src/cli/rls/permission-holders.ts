import type { RlsSqlContext } from "../sql/context.ts";

import { scopeTypeOf } from "../sql/columns.ts";
import { hasPermittedUsers, scopeTable } from "../sql/names.ts";
import { qualified, quoteIdent, quoteQualified } from "../sql/quote.ts";
import { globalRoleRows } from "./helper-rows.ts";
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

/**
 * One `permitted_<scope>_users(p_permission, p_id)` per scope in `database`
 * mode: the users who hold a permission key on one instance, read from the
 * scope's membership rows and the global-roles table and kept when
 * `permitted_<scope>_ids_by_permission_for` lists the instance or
 * `permdock_has_permission_for` answers, so denies, custom roles, expiry and
 * suspension apply as for the user. It names other users, so no client role may
 * execute it, and a backend role needs its own grant.
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
    return `-- the users who hold a permission on one ${name}: its members and the global-role holders for whom the _for helpers answer; no client role may execute it
create or replace function ${fn}(p_permission text, p_id ${type})
returns setof ${user}
${functionBody(
  candidates.keys,
  `  select c.user_id
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
  order by 1`,
)}
revoke execute on function ${fn}(text, ${type}) from public, anon, authenticated;`;
  });
  return `${chunks.join("\n\n")}\n`;
}
