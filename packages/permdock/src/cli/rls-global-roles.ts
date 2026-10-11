import type { RlsSqlContext } from "./sql/context.ts";

import { globalRoleSource } from "./global-roles.ts";
import {
  qualified,
  quoteIdent,
  quoteQualified,
  quoteTable,
} from "./sql/quote.ts";
import { GLOBAL_ROLES } from "./sql/shared.ts";

/**
 * `permdock_replace_global_roles(p_user, p_roles)`: sets the global roles of
 * one user in `rls.roles` in one statement pair. It runs as the invoker, so
 * the table's policies and the `rls.assignments` trigger judge every row it
 * deletes or inserts.
 */
export function globalRolesSql(ctx: RlsSqlContext): string {
  if (ctx.roles === undefined) {
    return "";
  }
  const source = globalRoleSource(
    ctx.roles,
    "public",
    "t",
    ctx.customRoles?.table,
  );
  const table = quoteQualified(ctx.roles.table);
  const user = quoteIdent(source.user);
  const fn = qualified(ctx, GLOBAL_ROLES.replace);
  const type = ctx.dialect === "supabase" ? "uuid" : "text";
  const wanted = `select distinct r from unnest(coalesce(p_roles, '{}'::text[])) r where r is not null`;
  const through = source.through;
  let body: string;
  if (through === undefined) {
    const role = typeof ctx.roles.role === "string" ? ctx.roles.role : "role";
    const column = quoteIdent(role);
    body = `  delete from ${table} t
  where t.${user} = p_user
    and t.${column}::text <> all(coalesce(p_roles, '{}'::text[]));
  insert into ${table} (${user}, ${column})
  select p_user, w.r
  from (${wanted}) w(r)
  where not exists (
    select 1 from ${table} t where t.${user} = p_user and t.${column}::text = w.r
  );`;
  } else {
    const keys = quoteTable(through.table);
    const id = quoteIdent(through.id);
    const key = quoteIdent(through.key);
    const ref = quoteIdent(through.ref);
    const global =
      source.tenant === undefined
        ? ""
        : ` and k.${quoteIdent(source.tenant)} is null`;
    body = `  select string_agg(w.r, ', ' order by w.r) into v_unknown
  from (${wanted}) w(r)
  where not exists (select 1 from ${keys} k where k.${key}::text = w.r${global});
  if v_unknown is not null then
    raise exception using
      errcode = '22023',
      message = 'permdock: ' || v_unknown || ' is not a role',
      hint = 'unknown-role';
  end if;
  delete from ${table} t
  where t.${user} = p_user
    and not exists (
      select 1 from ${keys} k
      where k.${id} = t.${ref}
        and k.${key}::text = any(coalesce(p_roles, '{}'::text[]))${global}
    );
  insert into ${table} (${user}, ${ref})
  select p_user, k.${id}
  from ${keys} k
  where k.${key}::text in (${wanted})${global}
    and not exists (
      select 1 from ${table} t where t.${user} = p_user and t.${ref} = k.${id}
    );`;
  }
  const declare = through === undefined ? "" : "declare\n  v_unknown text;\n";
  const args = `${type}, text[]`;
  return `-- set the global roles of a user: delete the others and insert the missing ones, as the caller, so the table's policies and the assignment trigger still apply
create or replace function ${fn}(p_user ${type}, p_roles text[])
returns void
language plpgsql
volatile
set search_path = ''
as $$
${declare}begin
${body}
end;
$$;
revoke execute on function ${fn}(${args}) from public, anon;
grant execute on function ${fn}(${args}) to authenticated;`;
}
