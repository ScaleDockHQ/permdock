import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsCustomRolesFrom, RlsMigrateConfig } from "../types.ts";

import { qualifySqlTable } from "../../core/sql.ts";
import { qualified, quoteIdent, quoteTable } from "../sql/quote.ts";
import { CUSTOM_ROLES } from "../sql/shared.ts";
import { DROPPED_LIST, rebuildPlan } from "./custom-role-rebuild.ts";

/**
 * `rls.customRoles.from.sync: 'trigger'`: after-row triggers on the legacy
 * permissions table, and on the includes table when mapped, rebuild each
 * affected role through `permdock_trusted_replace_custom_role_grants`, with
 * the same reads the backfill uses. An entry outside the ceiling is dropped
 * with a warning rather than aborting the legacy write, and a tenant role
 * whose name a shared role holds is skipped with a warning (`name-taken`).
 */
export function customRoleSyncSql(
  ctx: RlsSqlContext,
  from: RlsCustomRolesFrom,
  migrate: RlsMigrateConfig | undefined,
): string {
  const plan = rebuildPlan(ctx, from, migrate);
  const shared = qualified(ctx, CUSTOM_ROLES.shared);
  const match = `c.tenant_id is not distinct from v.tenant_id and c.scope = v.scope and c.scope_id is not distinct from v.scope_id and c.role = v.role`;
  const keepIncludes =
    plan.includesRef === undefined
      ? `
    v_include := array(select c.include_role from ${plan.includes} c where ${match});`
      : "";
  const one = (
    name: string,
    table: string,
    ref: { readonly ref: string; readonly id: string },
  ): string => {
    const fn = qualified(ctx, `${CUSTOM_ROLES.sync}_${name}`);
    const target = quoteTable(qualifySqlTable(table));
    const trigger = `${CUSTOM_ROLES.sync}_${name}`;
    return `create or replace function ${fn}()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_allow text[];
  v_deny text[];
  v_include text[];
  v_lost text[];
  v_dropped text[];
  v_refs text[] := array[
    case when tg_op <> 'INSERT' then old.${quoteIdent(ref.ref)}::text end,
    case when tg_op <> 'DELETE' then new.${quoteIdent(ref.ref)}::text end
  ];
begin
  for v in
    ${plan.identity}
    from ${plan.rolesTable} r
    where ${plan.eligible} and r.${quoteIdent(ref.id)}::text = any(v_refs)
  loop
    if v.role is null or not (v.scope = 'global' or v.scope = any(${plan.scopes})) then
      raise warning 'permdock sync: % has scope %, which is not declared', coalesce(v.role, 'null'), coalesce(v.scope, 'null');
      continue;
    end if;
    if v.tenant_id is not null and ${shared}(v.scope, v.role) then
      raise warning 'permdock sync: % is the name of a shared custom role (name-taken); the legacy write is not copied', v.role;
      continue;
    end if;
    v_dropped := '{}'::text[];
${plan.collect}${keepIncludes}
    perform ${plan.replace}(v.tenant_id, v.scope, v.scope_id, v.role, v_allow, v_deny, v_include);
    if cardinality(v_dropped) > 0 then
      raise warning 'permdock sync: dropped % entr(ies) PermDock cannot hold: %', cardinality(v_dropped), ${DROPPED_LIST};
    end if;
  end loop;
  return null;
end;
$$;
revoke execute on function ${fn}() from public, anon, authenticated;
drop trigger if exists ${quoteIdent(trigger)} on ${target};
create trigger ${quoteIdent(trigger)}
  after insert or update or delete on ${target}
  for each row execute function ${fn}();`;
  };
  const chunks = [
    `-- rls.customRoles.from.sync: a write to the application's role tables rebuilds the role's PermDock grants`,
    one("permissions", from.permissions.table, plan.permsRef),
  ];
  if (from.includes !== undefined && plan.includesRef !== undefined) {
    chunks.push(one("includes", from.includes.table, plan.includesRef));
  }
  return `${chunks.join("\n\n")}\n`;
}
