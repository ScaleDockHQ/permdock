import type { RlsSqlContext } from "../sql/context.ts";
import type { RlsCustomRolesFrom, RlsMigrateConfig } from "../types.ts";

import { qualifySqlTable } from "../../core/sql.ts";
import { BACKFILL_MARKER } from "../sql/markers.ts";
import { DROPPED_LIST, rebuildPlan } from "./custom-role-rebuild.ts";

export { legacyKeySql } from "./custom-role-rebuild.ts";

/**
 * The `--backfill-out` migration: every custom role in the application's
 * roles table that has no rows in `custom_role_permissions` or
 * `custom_role_includes` yet is saved through
 * `permdock_trusted_replace_custom_role_grants`, with the entries PermDock
 * cannot hold left out and listed in one warning. Running it again copies
 * nothing, so a role edited after the copy keeps its edits.
 */
export function backfillSql(
  ctx: RlsSqlContext,
  from: RlsCustomRolesFrom,
  migrate: RlsMigrateConfig | undefined,
): string {
  const plan = rebuildPlan(ctx, from, migrate);
  const { rolesTable, perms, includes, replace, scopes } = plan;
  return `${BACKFILL_MARKER} schema=${ctx.schema ?? "permdock"}
-- custom roles copied from ${qualifySqlTable(plan.roles.table)} (rls.customRoles.from) through ${replace}
-- a role that already has rows is left as it is; entries PermDock cannot hold are dropped and listed in one warning
do $permdock$
declare
  v record;
  v_allow text[];
  v_deny text[];
  v_include text[];
  v_lost text[];
  v_dropped text[] := '{}'::text[];
  v_copied integer := 0;
  v_present integer := 0;
begin
  for v in
    ${plan.identity}
    from ${rolesTable} r
    where ${plan.eligible}
    order by 4, 2, 1, 3
  loop
    if v.role is null or not (v.scope = 'global' or v.scope = any(${scopes})) then
      v_dropped := v_dropped || (coalesce(v.role, 'null') || ': scope ' || coalesce(v.scope, 'null') || ' is not declared');
      continue;
    end if;
    if exists (
      select 1 from ${perms} c
      where c.tenant_id is not distinct from v.tenant_id and c.scope = v.scope and c.scope_id is not distinct from v.scope_id and c.role = v.role
    ) or exists (
      select 1 from ${includes} c
      where c.tenant_id is not distinct from v.tenant_id and c.scope = v.scope and c.scope_id is not distinct from v.scope_id and c.role = v.role
    ) then
      v_present := v_present + 1;
      continue;
    end if;
${plan.collect}
    if v_allow is null and v_deny is null and v_include is null then
      continue;
    end if;
    perform ${replace}(v.tenant_id, v.scope, v.scope_id, v.role, v_allow, v_deny, v_include);
    v_copied := v_copied + 1;
  end loop;
  raise notice 'permdock backfill: copied % custom role(s), % already present', v_copied, v_present;
  if cardinality(v_dropped) > 0 then
    raise warning 'permdock backfill: dropped % entr(ies) PermDock cannot hold: %', cardinality(v_dropped), ${DROPPED_LIST};
  end if;
end
$permdock$;
`;
}
