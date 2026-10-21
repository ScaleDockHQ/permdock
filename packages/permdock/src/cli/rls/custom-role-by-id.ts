import type { RlsSqlContext } from "../sql/context.ts";

import { sqlTextArray } from "../../core/sql.ts";
import { configError } from "../core/errors.ts";
import { byKey } from "../shared/compare.ts";
import { tenantTypeOf } from "../sql/columns.ts";
import {
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { CUSTOM_ROLES } from "../sql/shared.ts";
import {
  currentKeyExpr,
  raiseSql,
  rolesTableScope,
  trustedReaderGrants,
} from "./custom-roles.ts";

const PREFIX = "PermDock CLI";

const col = (name: string): string => `r.${quoteIdent(name)}`;

/**
 * Custom-role functions keyed by the application's role row
 * (`rls.customRoleWrites.roles.primaryKey`): the tenant, scope, instance and
 * name come from the row, never from the caller. The writers delegate to
 * `permdock_replace_custom_role_grants` (or its trusted variant), so every
 * caller and definition check applies, and keep the stored denies and includes.
 * The reader returns declared allow keys only and is executable by
 * `rls.trustedReaders` alone.
 */
export function customRoleByIdSql(
  ctx: RlsSqlContext,
  trustedReaders: readonly string[] | undefined,
): string {
  const custom = ctx.customRoles;
  const roles = custom?.table;
  const root = ctx.scopes[0]?.name;
  if (
    custom === undefined ||
    roles?.primaryKey === undefined ||
    ctx.authorize !== "database" ||
    root === undefined
  ) {
    return "";
  }
  const pk = roles.primaryKey;
  if (pk === "") {
    throw configError(
      `${PREFIX}: rls.customRoleWrites.roles.primaryKey names no column`,
    );
  }
  const leveled = custom.levels === true;
  const tenantType = tenantTypeOf(ctx);
  const table = quoteQualified(roles.table);
  const idType = `${table}.${quoteIdent(pk)}%type`;
  const perms = qualified(ctx, CUSTOM_ROLES.permissions);
  const includes = qualified(ctx, CUSTOM_ROLES.includes);
  const replace = qualified(ctx, CUSTOM_ROLES.replace);
  const trustedReplace = qualified(ctx, CUSTOM_ROLES.trustedReplace);
  const byId = qualified(ctx, CUSTOM_ROLES.replaceById);
  const trustedById = qualified(ctx, CUSTOM_ROLES.trustedReplaceById);
  const reader = qualified(ctx, CUSTOM_ROLES.trustedReadById);
  const renames = Object.entries(custom.renamed ?? {}).toSorted(byKey);
  const current = (expr: string): string => currentKeyExpr(renames, expr);
  const declaredKeys = sqlTextArray(custom.permissions ?? []);
  const declaredRoles = sqlTextArray(custom.declared);

  const tenant =
    roles.tenant === undefined
      ? `null::${tenantType}`
      : `${col(roles.tenant)}::${tenantType}`;
  const scope = rolesTableScope(roles, tenant, root, col);
  const scopeId =
    roles.id === undefined || roles.tenant === undefined
      ? "null::text"
      : `case when ${tenant} is null then null else ${col(roles.id)}::text end`;
  const skipped =
    roles.skip === undefined || roles.tenant === undefined
      ? "false"
      : `(${tenant} is not null and coalesce(${col(roles.skip)}, false))`;
  const match =
    "c.tenant_id is not distinct from v_tenant and c.scope = v_scope and c.scope_id is not distinct from v_scope_id and c.role = v_key";

  const audit = custom.audit;
  const auditCall =
    audit === undefined
      ? ""
      : `
  perform ${quoteQualified(audit.function)}(${[
    "event_type => 'permdock.custom_role.replaced'",
    "target_type => 'role'",
    "record_id => p_role_id::text",
    "tenant => v_tenant",
    "metadata => jsonb_build_object('operation', 'replace', 'role', v_key, 'permissions', p_permissions)",
    ...Object.entries(audit.args ?? {})
      .toSorted(byKey)
      .map(([name, value]) => `${quoteIdent(name)} => ${quoteLiteral(value)}`),
  ].join(", ")});`;

  const body = (write: string): string => `declare
  v_tenant ${tenantType};
  v_scope text;
  v_scope_id text;
  v_key text;
  v_skipped boolean;
  v_deny text[];
  v_include text[];
begin
  select ${tenant}, ${scope}, ${scopeId}, ${col(roles.key)}::text, ${skipped}
  into v_tenant, v_scope, v_scope_id, v_key, v_skipped
  from ${table} r
  where ${col(pk)} = p_role_id;
  if not found then
${raiseSql("    ", "P0002", "'permdock: no role row has id ' || coalesce(p_role_id::text, 'null')", "unknown-role")}
  end if;
  if v_skipped or v_key = any(${declaredRoles}) then
${raiseSql("    ", "22023", "'permdock: ' || coalesce(v_key, 'null') || ' is a declared role, not a custom role'", "declared-role")}
  end if;
  select array_agg(c.permission) into v_deny
  from ${perms} c
  where ${match} and c.effect = 'deny';
  select array_agg(c.include_role) into v_include
  from ${includes} c
  where ${match};
  perform ${write}(v_tenant, v_scope, v_scope_id, v_key, p_permissions, v_deny, v_include);${auditCall}
end;`;

  const writer = (
    comment: string,
    name: string,
    write: string,
    member: boolean,
  ): string => `-- ${comment}
create or replace function ${name}(p_role_id ${idType}, p_permissions text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
${body(write)}
$$;
${
  member
    ? `revoke execute on function ${name}(${idType}, text[]) from public, anon;
grant execute on function ${name}(${idType}, text[]) to authenticated;`
    : `revoke execute on function ${name}(${idType}, text[]) from public, anon, authenticated;`
}`;

  const readerEntry = leveled
    ? `${current("c.permission")} || coalesce('@' || c.level, '')`
    : current("c.permission");
  const readerGrant =
    trustedReaders === undefined || trustedReaders.length === 0
      ? ""
      : `\n${trustedReaderGrants(ctx, `${reader}(text[], ${tenantType})`, trustedReaders)}`;

  return `${writer(
    "save a custom role by its row id: the row supplies tenant, scope, instance and name; the caller checks of permdock_replace_custom_role_grants apply, and stored denies and includes stay",
    byId,
    replace,
    true,
  )}

${writer(
  "save a custom role by its row id for a trusted caller: the definition checks without the caller checks",
  trustedById,
  trustedReplace,
  false,
)}

-- the declared allow keys of custom roles by their row ids as text, for a trusted reader; with p_tenant, an id of another tenant is refused
create or replace function ${reader}(p_role_ids text[], p_tenant ${tenantType} default null)
returns table (role_id text, permission text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_tenant is not null and exists (
    select 1 from ${table} r
    where ${col(pk)}::text = any(p_role_ids) and ${tenant} is distinct from p_tenant
  ) then
${raiseSql("    ", "42501", "'permdock: a role id belongs to another tenant than ' || p_tenant::text", "not-member")}
  end if;
  return query
  select distinct v.role_id, ${readerEntry}
  from (
    select ${col(pk)}::text as role_id, ${tenant} as tenant_id, ${scope} as scope, ${scopeId} as scope_id, ${col(roles.key)}::text as role
    from ${table} r
    where ${col(pk)}::text = any(p_role_ids)
      and not ${skipped}
      and not (${col(roles.key)}::text = any(${declaredRoles}))
  ) v
  join ${perms} c
    on c.tenant_id is not distinct from v.tenant_id
    and c.scope = v.scope
    and c.scope_id is not distinct from v.scope_id
    and c.role = v.role
  where c.effect = 'allow'
    and ${current("c.permission")} = any(${declaredKeys})
  order by 1, 2;
end;
$$;
revoke execute on function ${reader}(text[], ${tenantType}) from public, anon, authenticated;${readerGrant}`;
}
