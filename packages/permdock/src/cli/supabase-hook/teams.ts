import type { Parts } from "./parts.ts";

import { activeRowSql } from "../sql/active.ts";
import { isTeamScope, memberOfHelper } from "../sql/names.ts";
import { quoteIdent, quoteQualified } from "../sql/quote.ts";

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
 * `member_team_ids_of(p_user uuid)`: the teams `supabase.hook.teams` lists for
 * the caller, the rows the hook writes to `team_ids`. Any other `p_user`, and a
 * suspended user, gets no rows, so `authenticated` may execute it. The team
 * column is a uuid, as the `team_ids` claim is.
 */
export function teamIdsOfSql(parts: Parts): string {
  const name = hookTeamsHelper(parts);
  const teams = parts.hook.teams;
  if (name === undefined || teams === undefined) {
    return "";
  }
  const fn = `${quoteIdent(parts.helpers.schema)}.${quoteIdent(name)}`;
  const active =
    parts.users === undefined
      ? ""
      : `\n    and ${activeRowSql(parts.users, "p_user")}`;
  return `-- the caller's teams from supabase.hook.teams, for better-supabase's teamIdsOf
create or replace function ${fn}(p_user uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.${quoteIdent(teams.team)}
  from ${quoteQualified(teams.table)} t
  where t.${quoteIdent(teams.user)} = p_user
    and p_user = (select auth.uid())${active}
$$;
revoke execute on function ${fn}(uuid) from public, anon;
grant execute on function ${fn}(uuid) to authenticated;`;
}
