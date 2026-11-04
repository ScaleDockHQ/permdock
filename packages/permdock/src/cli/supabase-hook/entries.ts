import type { Parts } from "./parts.ts";

import { quoteIdent, quoteLiteral, quoteQualified } from "../sql/quote.ts";
import { entriesSql, typedSourceUsers } from "./memberships.ts";

export const MEMBERSHIP_ENTRIES_FOR = "membership_entries_for";
const GLOBAL_ROLES_FOR = "global_roles_for";

function qualified(parts: Parts, name: string): string {
  return `${quoteIdent(parts.schema)}.${name}`;
}

/**
 * `membership_entries_for(p_user uuid) returns table(ord int, entry jsonb)`:
 * every membership entry the hook and `subject_for` read, one row per entry in
 * the shape of a token's `memberships` claim. Both callers order and budget the
 * rows themselves; the function never truncates. `security invoker`, so the
 * caller's table reads apply.
 */
export function membershipEntriesSql(parts: Parts): string {
  const fn = qualified(parts, MEMBERSHIP_ENTRIES_FOR);
  return `-- the membership entries the hook and subject_for read for p_user; no client role may execute it
create or replace function ${fn}(p_user uuid)
returns table (ord integer, entry jsonb)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare${typedSourceUsers(parts)}
begin
  return query
  select x.ord, x.entry
  from (
${entriesSql(parts).replaceAll(/^/gmu, "    ")}
  ) x;
end;
$$;
revoke execute on function ${fn}(uuid) from public, anon, authenticated;`;
}

/**
 * `global_roles_for(p_user uuid) returns jsonb`: the sorted, distinct global
 * roles of `p_user` as a json array, for the hook's `roles` and `user_role`
 * claims and for `subject_for`. Empty without a roles source.
 */
export function globalRolesSql(parts: Parts): string {
  const rows = parts.roles;
  if (rows === undefined) {
    return "";
  }
  const fn = qualified(parts, GLOBAL_ROLES_FOR);
  return `-- the global roles of p_user as a json array; no client role may execute it
create or replace function ${fn}(p_user uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_roles_user ${quoteQualified(rows.table)}.${quoteIdent(rows.user)}%type := p_user;
  held jsonb;
begin
  select coalesce(jsonb_agg(distinct ${rows.roleSql} order by ${rows.roleSql}) filter (where ${rows.roleSql} is not null), '[]'::jsonb)
    into held
    from ${rows.from}
    where ${rows.userSql} = v_roles_user;
  return held;
end;
$$;
revoke execute on function ${fn}(uuid) from public, anon, authenticated;`;
}

/**
 * Execute on both readers for the invoker hook, which runs as
 * `supabase_auth_admin`.
 */
export function entriesGrantsSql(parts: Parts): string {
  const names = [
    MEMBERSHIP_ENTRIES_FOR,
    ...(parts.roles === undefined ? [] : [GLOBAL_ROLES_FOR]),
  ];
  return names
    .map(
      (name) =>
        `\ngrant execute on function ${qualified(parts, name)}(uuid) to supabase_auth_admin;`,
    )
    .join("");
}

/** The `held` assignment, from `global_roles_for` or an empty array. */
export function heldSql(parts: Parts, user: string): string {
  return parts.roles === undefined
    ? `  held := '[]'::jsonb;`
    : `  held := ${qualified(parts, GLOBAL_ROLES_FOR)}(${user});`;
}

/** The tenant id of an entry, as the hook orders by it. */
export function entryTenantSql(parts: Parts, alias: string): string {
  const root = quoteLiteral(parts.root);
  return `case when ${alias}.entry ->> 'scope' = ${root} then ${alias}.entry ->> 'id' else ${alias}.entry -> 'within' ->> ${root} end`;
}
