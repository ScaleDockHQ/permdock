import type { RlsSqlContext } from "../sql/context.ts";

import { qualifySqlTable } from "../../core/sql.ts";
import { tenantTypeOf } from "../sql/columns.ts";
import { qualified, quoteIdent, quoteTable } from "../sql/quote.ts";
import { CUSTOM_ROLES, signedIn } from "../sql/shared.ts";
import { raiseSql, rolesTableScope } from "./custom-roles.ts";

/** `row.column`, for a trigger's `old` or `new`. */
function rowColumn(row: string, name: string): string {
  return `${row}.${quoteIdent(name)}`;
}

/** The custom-role rows of the role a trigger's `v_<prefix>_*` variables name. */
function cascadeMatch(prefix: string): string {
  return `c.tenant_id is not distinct from v_${prefix}_tenant and c.scope = v_${prefix}_scope and c.scope_id is not distinct from v_${prefix}_id and c.role = v_${prefix}_key`;
}

/**
 * The trigger on the application's roles table (`rls.customRoleWrites.roles`):
 * a rename, a move to another tenant, scope or instance, or a delete of a
 * custom role's row carries its grants and includes along. A signed-in
 * caller at trigger depth 1 passes the write functions' checks: authority
 * over the stored definition where it was, and, after a move, membership
 * and authority where it lands and entries inside that scope's ceiling.
 * Other paths (a migration, a job, a nested trigger) move the rows as the
 * function owner.
 */
export function customRoleCascadeSql(ctx: RlsSqlContext): string {
  const custom = ctx.customRoles;
  const table = custom?.table;
  const root = ctx.scopes[0]?.name;
  if (custom === undefined || table === undefined || root === undefined) {
    return "";
  }
  const tenantType = tenantTypeOf(ctx);
  const perms = qualified(ctx, CUSTOM_ROLES.permissions);
  const includes = qualified(ctx, CUSTOM_ROLES.includes);
  const fn = qualified(ctx, CUSTOM_ROLES.cascade);
  const target = quoteTable(qualifySqlTable(table.table));
  const tenant = (row: string): string =>
    table.tenant === undefined
      ? `null::${tenantType}`
      : `${rowColumn(row, table.tenant)}::${tenantType}`;
  const scope = (row: string): string =>
    rolesTableScope(table, tenant(row), root, (name) => rowColumn(row, name));
  const id = (row: string): string =>
    table.id === undefined ? "null::text" : `${rowColumn(row, table.id)}::text`;
  const skipped = (row: string): string =>
    table.skip === undefined
      ? "false"
      : `coalesce(${rowColumn(row, table.skip)}, false)`;
  const guard = qualified(ctx, CUSTOM_ROLES.guard);
  const entries = qualified(ctx, CUSTOM_ROLES.entries);
  const allowEntryOf =
    custom.levels === true
      ? "c.permission || coalesce('@' || c.level, '')"
      : "c.permission";
  return `-- the application's roles table: renames, moves and deletes of a custom role carry its grants and includes
create or replace function ${fn}()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old_tenant ${tenantType} := ${tenant("old")};
  v_old_scope text := ${scope("old")};
  v_old_id text := ${id("old")};
  v_old_key text := ${rowColumn("old", table.key)}::text;
  v_new_tenant ${tenantType};
  v_new_scope text;
  v_new_id text;
  v_new_key text;
  v_checked boolean := ${signedIn(ctx)} and pg_trigger_depth() = 1;
  v_allow text[];
  v_deny text[];
  v_include text[];
begin
  if ${skipped("old")} then
    return null;
  end if;
  if tg_op = 'UPDATE' and not ${skipped("new")} then
    v_new_tenant := ${tenant("new")};
    v_new_scope := ${scope("new")};
    v_new_id := ${id("new")};
    v_new_key := ${rowColumn("new", table.key)}::text;
    if v_new_key = v_old_key
      and v_new_tenant is not distinct from v_old_tenant
      and v_new_scope = v_old_scope
      and v_new_id is not distinct from v_old_id then
      return null;
    end if;
  end if;
  if not exists (select 1 from ${perms} c where ${cascadeMatch("old")})
    and not exists (select 1 from ${includes} c where ${cascadeMatch("old")}) then
    return null;
  end if;
  if v_checked then
    perform ${guard}(v_old_tenant, v_old_scope, v_old_id, v_old_key);
  end if;
  if v_new_key is null then
    delete from ${perms} c where ${cascadeMatch("old")};
    delete from ${includes} c where ${cascadeMatch("old")};
    return null;
  end if;
  if exists (select 1 from ${perms} c where ${cascadeMatch("new")})
    or exists (select 1 from ${includes} c where ${cascadeMatch("new")}) then
${raiseSql("    ", "22023", `'permdock: ' || v_new_key || ' already has grants'`, "role-exists")}
  end if;
  update ${perms} c set tenant_id = v_new_tenant, scope = v_new_scope, scope_id = v_new_id, role = v_new_key where ${cascadeMatch("old")};
  update ${includes} c set tenant_id = v_new_tenant, scope = v_new_scope, scope_id = v_new_id, role = v_new_key where ${cascadeMatch("old")};
  if v_checked then
    perform ${guard}(v_new_tenant, v_new_scope, v_new_id, v_new_key);
    select array_agg(${allowEntryOf}) filter (where c.effect = 'allow'),
      array_agg(c.permission) filter (where c.effect = 'deny')
    into v_allow, v_deny
    from ${perms} c
    where ${cascadeMatch("new")};
    select array_agg(c.include_role) into v_include
    from ${includes} c
    where ${cascadeMatch("new")};
    perform ${entries}(v_new_scope, v_allow, v_deny, v_include);
  end if;
  return null;
end;
$$;
revoke execute on function ${fn}() from public, anon, authenticated;
drop trigger if exists "permdock_custom_role_cascade" on ${target};
create trigger "permdock_custom_role_cascade"
  after update or delete on ${target}
  for each row execute function ${fn}();
`;
}
