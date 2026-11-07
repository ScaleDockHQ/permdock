import type { RlsSqlContext } from "../sql/context.ts";
import type { Parts } from "./parts.ts";

import { activeRowSql, activeUserSql } from "../sql/active.ts";
import { hasMemberOf, isTeamScope, memberOfHelper } from "../sql/names.ts";
import { helperSchema, quoteIdent, quoteQualified } from "../sql/quote.ts";

/**
 * The `member_team_ids_of` helper the hook file writes from
 * `supabase.hook.teams`, or `undefined` when there is no teams table or `rls
 * generate` already writes one for a `team` or `teams` scope.
 */
export function hookTeamsHelper(parts: Parts): string | undefined {
  if (parts.hook.teams === undefined) {
    return undefined;
  }
  const scoped = parts.helpers.memberFor.some((scope) => isTeamScope(scope));
  return scoped ? undefined : memberOfHelper("team");
}

/**
 * `member_team_ids_for` and `member_team_ids_of` for the helpers file.
 * `member_team_ids_for` takes the user and never compares it with `auth.uid()`.
 * The wrapper answers the caller only. Empty when a team scope already writes
 * the same names.
 */
export function hookTeamReadersSql(ctx: RlsSqlContext): string {
  const teams = ctx.hookTeams;
  if (
    teams === undefined ||
    ctx.scopes.some((scope) => hasMemberOf(ctx, scope.name))
  ) {
    return "";
  }
  const definer = ctx.hookSecurity === "definer";
  const schema = quoteIdent(helperSchema(ctx));
  const reader = `${schema}.${quoteIdent("member_team_ids_for")}`;
  const wrapper = `${schema}.${quoteIdent("member_team_ids_of")}`;
  const root = ctx.scopes[0]?.name;
  const tenantRow =
    root === undefined ? undefined : ctx.suspension?.scopes?.[root];
  const filters = [
    ...activeUserSql(ctx, "p_user").map((part) => `    and ${part}`),
    ...(tenantRow === undefined || teams.tenant === undefined
      ? []
      : [
          `    and ${activeRowSql(tenantRow, `t.${quoteIdent(teams.tenant)}`)}`,
        ]),
  ];
  const order =
    teams.tenant === undefined
      ? `t.${quoteIdent(teams.team)}`
      : `(p_active is not null and t.${quoteIdent(teams.tenant)}::text is not distinct from p_active) desc, t.${quoteIdent(teams.team)}`;
  return `-- teams of p_user from supabase.hook.teams; ${definer ? "only the hook's owner executes it" : "execute is supabase_auth_admin only"}
create or replace function ${reader}(p_user uuid, p_active text default null)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.${quoteIdent(teams.team)}
  from ${quoteQualified(teams.table)} t
  where t.${quoteIdent(teams.user)} = p_user
${filters.join("\n")}
  order by ${order}
$$;
revoke execute on function ${reader}(uuid, text) from public, anon, authenticated;${definer ? "" : `\ngrant execute on function ${reader}(uuid, text) to supabase_auth_admin;`}

-- the caller's teams only, for better-supabase's teamIdsOf
create or replace function ${wrapper}(p_user uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id
  from ${reader}(p_user, null) as m(id)
  where p_user = (select ${schema}.permdock_user_id())
$$;
revoke execute on function ${wrapper}(uuid) from public, anon;
grant execute on function ${wrapper}(uuid) to authenticated;`;
}
