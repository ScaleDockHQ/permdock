import type { RlsActiveRow } from "../types.ts";
import type { Parts } from "./parts.ts";

import { qualifySqlTable } from "../../core/sql.ts";
import { activeRowSql } from "../sql/active.ts";
import {
  quoteIdent,
  quoteLiteral,
  quoteQualified,
  quoteTable,
} from "../sql/quote.ts";
import { entriesSql, typedSourceUsers } from "./memberships.ts";

export const MEMBERSHIPS_FOR = "memberships_for";
const GLOBAL_ROLES_FOR = "global_roles_for";

function qualified(parts: Parts, name: string): string {
  return `${quoteIdent(parts.schema)}.${name}`;
}

/**
 * `memberships_for(p_user uuid) returns table(ord int, entry jsonb)`: every
 * membership entry the hook and `subject_for` read, one row per entry in the
 * shape of a token's `memberships` claim. Both callers order and budget the
 * rows themselves; the function never truncates. A suspended user has no
 * entries, and an entry in a suspended tenant (`rls.suspension.scopes.<root>`)
 * is dropped unless it carries the keys the tenant keeps, whatever the source
 * filters itself. `security definer`, and it never compares `p_user` with
 * `auth.uid()`. Execute belongs to `supabase_auth_admin` only.
 */
export function membershipEntriesSql(parts: Parts): string {
  return `${entriesFunction(parts, false)}\n\n${entriesFunction(parts, true)}`;
}

/**
 * `memberships_for(p_user uuid, p_tenant text)`: the entries of `p_tenant`
 * alone, filtered inside each source's read so a user in many tenants costs one
 * tenant's rows. A null or unknown tenant answers no rows. `p_tenant` is text
 * because an entry's tenant is the text of its id; `subject_for(p_user,
 * p_tenant)` passes its tenant cast to text. Execute belongs to no client
 * role.
 */
function entriesFunction(parts: Parts, tenant: boolean): string {
  const fn = qualified(parts, MEMBERSHIPS_FOR);
  const params = tenant ? "p_user uuid, p_tenant text" : "p_user uuid";
  const types = tenant ? "uuid, text" : "uuid";
  const suspended =
    parts.users === undefined
      ? ""
      : `
  if not ${activeRowSql(parts.users, "p_user")} then
    return;
  end if;`;
  const filters = [
    ...(tenant ? ["x.tenant = p_tenant"] : []),
    ...(parts.tenants === undefined
      ? []
      : [
          `(x.tenant is null or x.entry ? 'keep' or ${activeTenantSql(parts, parts.tenants, "x.tenant")})`,
        ]),
  ];
  return `-- the membership entries ${tenant ? "of one tenant that subject_for(p_user, p_tenant) reads" : "the hook and subject_for read for p_user"}; no client role may execute it
create or replace function ${fn}(${params})
returns table (ord integer, entry jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare${typedSourceUsers(parts)}
begin${suspended}
  return query
  select x.ord, x.entry
  from (
${entriesSql(parts).replaceAll(/^/gmu, "    ")}
  ) x${filters.length === 0 ? "" : `\n  where ${filters.join("\n    and ")}`};
end;
$$;
revoke execute on function ${fn}(${types}) from public, anon, authenticated;`;
}

/**
 * Whether the tenant whose id is the text `id` has an active row: one indexed
 * lookup on the tenants table, with `id` cast to the root scope's type.
 */
function activeTenantSql(parts: Parts, row: RlsActiveRow, id: string): string {
  const where = [`s.${quoteIdent(row.id)} = (${id})::${parts.tenantType}`];
  if (row.disabledAt !== undefined) {
    where.push(`s.${quoteIdent(row.disabledAt)} is null`);
  }
  if (row.status !== undefined) {
    const values = (row.active ?? []).map(quoteLiteral).join(", ");
    where.push(
      `s.${quoteIdent(row.status)}::text = any(array[${values}]::text[])`,
    );
  }
  return `exists (select 1 from ${quoteTable(qualifySqlTable(row.table))} s where ${where.join(" and ")})`;
}

/**
 * `global_roles_for(p_user uuid) returns jsonb`: the sorted, distinct global
 * roles of `p_user` as a json array, for the hook's `roles` and `user_role`
 * claims and for `subject_for`. Empty without a roles source. `security
 * definer`, like `memberships_for`, so the hook needs no grant on the roles
 * tables.
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
security definer
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
    MEMBERSHIPS_FOR,
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
