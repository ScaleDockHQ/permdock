import type { RlsSqlContext } from "../sql/context.ts";

import { qualifySqlTable, sqlTextArray } from "../../core/sql.ts";
import { tenantTypeOf } from "../sql/columns.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteTable,
} from "../sql/quote.ts";
import { CUSTOM_ROLES } from "../sql/shared.ts";
import { raiseSql, rolesTableScope } from "./custom-roles.ts";

/** A column of the roles-table row a trigger sees as `new`. */
function column(name: string): string {
  return `new.${quoteIdent(name)}`;
}

/**
 * The trigger on the application's roles table (`rls.customRoleWrites.roles`)
 * that refuses a tenant row named like a declared role (`declared-role`) or
 * like a shared custom role (`name-taken`). A row the `skip` column marks is a
 * system role of the tenant and passes. Empty without a tenant column: then no
 * row is a tenant row.
 */
export function customRoleNameGuardSql(ctx: RlsSqlContext): string {
  const custom = ctx.customRoles;
  const table = custom?.table;
  const root = ctx.scopes[0]?.name;
  if (
    custom === undefined ||
    table?.tenant === undefined ||
    root === undefined
  ) {
    return "";
  }
  const tenant = `${column(table.tenant)}::${tenantTypeOf(ctx)}`;
  const skipped =
    table.skip === undefined
      ? "false"
      : `coalesce(${column(table.skip)}, false)`;
  const fn = qualified(ctx, CUSTOM_ROLES.nameGuard);
  const target = quoteTable(qualifySqlTable(table.table));
  const key = `${column(table.key)}::text`;
  const scope = rolesTableScope(table, tenant, root, column);
  return `-- the application's roles table: a tenant row cannot take the name of a declared or a shared role
create or replace function ${fn}()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if ${tenant} is null or ${skipped} then
    return new;
  end if;
  if ${key} = any(${sqlTextArray(custom.declared)}) then
${raiseSql("    ", "22023", `'permdock: ' || ${key} || ' is a declared role'`, "declared-role")}
  end if;
  if ${qualified(ctx, CUSTOM_ROLES.shared)}(${scope}, ${key}) then
${raiseSql("    ", "22023", `'permdock: ' || ${key} || ' is a shared role'`, "name-taken")}
  end if;
  return new;
end;
$$;
revoke execute on function ${fn}() from public, anon, authenticated;
drop trigger if exists "permdock_custom_role_name_guard" on ${target};
create trigger "permdock_custom_role_name_guard"
  before insert or update on ${target}
  for each row execute function ${fn}();
${systemGuardSql(ctx, target, key)}`;
}

/** Postgres roles a client request runs as; any other role is trusted SQL. */
const CLIENT_ROLES = ["anon", "anonymous", "authenticated"] as const;

/**
 * The name guard lets a row the `skip` column marks through, so only trusted
 * SQL may mark one: a security invoker trigger refuses a client role that sets
 * the column, or renames or moves a row that has it. A row created by trusted
 * SQL, such as an organization's seeded system roles, keeps it.
 */
function systemGuardSql(
  ctx: RlsSqlContext,
  target: string,
  key: string,
): string {
  const table = ctx.customRoles?.table;
  if (table?.skip === undefined || table.tenant === undefined) {
    return "";
  }
  const fn = qualified(ctx, CUSTOM_ROLES.systemGuard);
  const skip = quoteIdent(table.skip);
  const tenant = quoteIdent(table.tenant);
  const clients = `current_user::text = any(array[${CLIENT_ROLES.map(quoteLiteral).join(", ")}])`;
  return `
-- the application's roles table: only trusted SQL marks a role as a system role, or renames or moves one
create or replace function ${fn}()
returns trigger
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  if not ${clients} then
    return new;
  end if;
  if (tg_op = 'INSERT' and coalesce(new.${skip}, false))
    or (tg_op = 'UPDATE' and (
      coalesce(new.${skip}, false) is distinct from coalesce(old.${skip}, false)
      or (coalesce(old.${skip}, false) and (${key} is distinct from old.${quoteIdent(table.key)}::text or new.${tenant} is distinct from old.${tenant}))
    )) then
${raiseSql("    ", "42501", "'permdock: only trusted SQL writes a system role'", "system-role")}
  end if;
  return new;
end;
$$;
revoke execute on function ${fn}() from public, anon, authenticated;
drop trigger if exists "permdock_custom_role_system_guard" on ${target};
create trigger "permdock_custom_role_system_guard"
  before insert or update on ${target}
  for each row execute function ${fn}();
`;
}
