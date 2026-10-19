import type { RlsSqlContext } from "../sql/context.ts";
import type {
  PermDockConfig,
  RlsAssignmentTable,
  RoleThrough,
} from "../types.ts";

import { type Scope, resolveScope } from "../../core/scopes.ts";
import { qualifySqlTable } from "../../core/sql.ts";
import { roleColumn } from "../../supabase/roles.ts";
import { configError } from "../core/errors.ts";
import { tenantTypeOf } from "../sql/columns.ts";
import { memberForTable, scopeTable } from "../sql/names.ts";
import {
  declaredArray,
  qualified,
  quoteIdent,
  quoteLiteral,
  quoteQualified,
} from "../sql/quote.ts";
import { CUSTOM_ROLES } from "../sql/shared.ts";
import { subjectIdSql } from "../sql/subject.ts";
import { ASSIGNMENTS, OWNERSHIP } from "./ownership-names.ts";

/** The client roles whose writes the assignment triggers check; any other role is a trusted path. */
const CLIENT_ROLES = ["anon", "anonymous", "authenticated"] as const;

/** One table whose rows assign a role at a scope instance, or a global role (`id` unset). */
type AssignedTable = {
  readonly table: string;
  readonly scope: string;
  readonly id?: string;
  readonly tenant?: string;
  readonly role: RlsAssignmentTable["role"];
  readonly user?: string;
};

/** The mapped membership tables, `rls.assignments.tables` and the global-roles table `rls.roles`. */
function assignedTables(ctx: RlsSqlContext): readonly AssignedTable[] {
  const out: AssignedTable[] = [];
  for (const { name } of ctx.scopes) {
    const mapped = scopeTable(ctx, name);
    if (mapped === undefined) {
      continue;
    }
    out.push({
      table: mapped.table.table,
      scope: name,
      id: mapped.column,
      tenant: mapped.tenantColumn ?? mapped.column,
      role: mapped.table.role,
      user: mapped.table.user,
    });
  }
  if (ctx.roles !== undefined) {
    out.push({
      table: ctx.roles.table,
      scope: "global",
      role: ctx.roles.role ?? "role",
      user: ctx.roles.user ?? "user_id",
    });
  }
  for (const extra of ctx.assignments?.tables ?? []) {
    const scope = resolveScope(ctx.scopes, extra.scope);
    if (scope === undefined) {
      throw configError(
        `PermDock CLI: rls.assignments.tables names scope '${extra.scope}', which the policy does not declare`,
      );
    }
    if (scope !== ctx.scopes[0]?.name && extra.tenant === undefined) {
      throw configError(
        `PermDock CLI: rls.assignments.tables entry ${extra.table} assigns at ${scope}, below the first scope: name its tenant column`,
      );
    }
    out.push({
      table: extra.table,
      scope,
      id: extra.id,
      tenant: extra.tenant ?? extra.id,
      role: extra.role,
      ...(extra.user === undefined ? {} : { user: extra.user }),
    });
  }
  return out;
}

/** The tables `rls.assignments.ownRole` refuses a caller's own rows on, by table key. */
function ownRoleTables(
  ctx: RlsSqlContext,
  tables: readonly AssignedTable[],
): ReadonlySet<string> {
  const own = ctx.assignments?.ownRole;
  if (own === undefined) {
    return new Set();
  }
  if (own === "refuse") {
    return new Set(
      tables
        .filter((entry) => entry.user !== undefined)
        .map((entry) => qualifySqlTable(entry.table)),
    );
  }
  const out = new Set<string>();
  for (const [name, value] of Object.entries(own)) {
    const entry = tables.find(
      (table) => qualifySqlTable(table.table) === qualifySqlTable(name),
    );
    if (entry === undefined) {
      throw configError(
        `PermDock CLI: rls.assignments.ownRole names ${name}, which no assignment trigger guards`,
      );
    }
    if (value !== "refuse") {
      throw configError(
        `PermDock CLI: rls.assignments.ownRole.${name} must be 'refuse'`,
      );
    }
    if (entry.user === undefined) {
      throw configError(
        `PermDock CLI: rls.assignments.ownRole names ${name}, which has no user column: set its user in rls.assignments.tables`,
      );
    }
    out.add(qualifySqlTable(entry.table));
  }
  return out;
}

/**
 * The tables `rls.assignments` guards, schema-qualified: each scope's mapped
 * membership table, the global-roles table (`rls.roles`, else
 * `supabase.hook.roles`) and `rls.assignments.tables`. Empty without
 * `rls.assignments`.
 */
export function guardedTables(
  config: PermDockConfig,
  scopes: readonly Scope[],
): readonly string[] {
  const rls = config.rls;
  if (rls?.assignments === undefined) {
    return [];
  }
  const hook = config.supabase?.hook?.roles;
  const roles = rls.roles ?? (hook === false ? undefined : hook);
  const tables = [
    ...scopes.flatMap((scope) => {
      const mapped = memberForTable(
        {
          scopes,
          ...(rls.memberships === undefined
            ? {}
            : { memberships: rls.memberships }),
        },
        scope.name,
      );
      return mapped === undefined ? [] : [mapped.table];
    }),
    ...(roles === undefined ? [] : [roles.table]),
    ...(rls.assignments === true ? [] : (rls.assignments.tables ?? [])).map(
      (entry) => entry.table,
    ),
  ];
  return [...new Set(tables.map(qualifySqlTable))];
}

function isRoleList(
  role: RlsAssignmentTable["role"],
): role is readonly (string | RoleThrough)[] {
  return Array.isArray(role);
}

/** The role keys a row variable holds, one scalar per role source. */
function rowRoles(entry: AssignedTable, row: string): readonly string[] {
  const parts: readonly (string | RoleThrough)[] = isRoleList(entry.role)
    ? entry.role
    : [entry.role];
  return parts.map(
    (part) =>
      roleColumn(part, qualifySqlTable(entry.table), row, {
        label: `rls.assignments ${entry.table} role`,
        prefix: "PermDock CLI",
      }).lookup,
  );
}

/**
 * `permdock_can_assign_custom_role`: whether the signed-in caller may assign a
 * custom role of the tenant at the instance, by the checks the custom-role
 * write functions run on its stored definition.
 */
export function canAssignCustomSql(
  ctx: RlsSqlContext,
  forUser = false,
): string {
  const tenantType = tenantTypeOf(ctx);
  const fn = qualified(
    ctx,
    forUser ? ASSIGNMENTS.customFor : ASSIGNMENTS.custom,
  );
  const perms = qualified(ctx, CUSTOM_ROLES.permissions);
  const includes = qualified(ctx, CUSTOM_ROLES.includes);
  const guard = qualified(
    ctx,
    forUser ? CUSTOM_ROLES.guardFor : CUSTOM_ROLES.guard,
  );
  const userParam = forUser ? "p_user uuid, " : "";
  const userArg = forUser ? "uuid, " : "";
  const stored = `c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.role = p_role and (c.scope_id is null or c.scope_id = p_scope_id)`;
  const grants = forUser
    ? `revoke execute on function ${fn}(${userArg}${tenantType}, text, text, text) from public, anon, authenticated;`
    : `revoke execute on function ${fn}(${tenantType}, text, text, text) from public, anon;
grant execute on function ${fn}(${tenantType}, text, text, text) to authenticated;`;
  return `-- whether ${forUser ? "user p_user" : "the caller"} may assign custom role p_role at instance p_scope_id (a platform role: null tenant, scope global): the custom-role write checks on its stored definition${forUser ? "; no client role may execute it" : ""}
create or replace function ${fn}(${userParam}p_tenant ${tenantType}, p_scope text, p_scope_id text, p_role text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_scope_id text;
  v_found boolean := false;
begin
  select true, c.scope_id into v_found, v_scope_id
  from (
    select c.scope_id from ${perms} c where ${stored}
    union all
    select c.scope_id from ${includes} c where ${stored}
  ) c
  order by c.scope_id nulls first
  limit 1;
  if not coalesce(v_found, false) then
    return false;
  end if;
  perform ${guard}(${forUser ? "p_user, " : ""}p_tenant, p_scope, v_scope_id, p_role);
  return true;
exception
  when insufficient_privilege or invalid_parameter_value then
    return false;
end;
$$;
${grants}`;
}

/**
 * The assignment triggers (\`rls.assignments\`): before a client role inserts,
 * updates or deletes a row that assigns a role, every role the old and new
 * row hold must be one the caller may assign at that instance, by
 * \`permdock_can_assign\` for a declared role and
 * \`permdock_can_assign_custom_role\` for a custom one. The functions run as
 * the invoker, so \`current_user\` tells a client write from a trusted one.
 */
export function assignmentSql(ctx: RlsSqlContext): string {
  const own = ctx.ownership;
  if (
    ctx.assignments === undefined ||
    own === undefined ||
    own.assigns.length === 0
  ) {
    return "";
  }
  const canAssign = qualified(ctx, OWNERSHIP.canAssign);
  const custom = ctx.customRoles !== undefined && ctx.authorize === "database";
  const declared = ctx.customRoles?.declared;
  const tenantType = tenantTypeOf(ctx);
  const chunks: string[] = [];
  const clients = `current_user::text = any(array[${CLIENT_ROLES.map(quoteLiteral).join(", ")}])`;
  const tables = assignedTables(ctx);
  const ownRole = ownRoleTables(ctx, tables);
  for (const entry of tables) {
    const table = quoteQualified(entry.table);
    const suffix = entry.table.replaceAll(/[^a-z0-9_]/gu, "_");
    const fn = qualified(ctx, quoteIdent(`${ASSIGNMENTS.trigger}_${suffix}`));
    const ownUser =
      entry.user !== undefined && ownRole.has(qualifySqlTable(entry.table))
        ? entry.user
        : undefined;
    const ownCheck = (row: string, reason: string): string =>
      ownUser === undefined
        ? ""
        : `    if ${row}.${quoteIdent(ownUser)}::text = (${subjectIdSql(ctx)})::text then
      raise exception using
        errcode = '42501',
        message = 'permdock: the caller may not change their own roles',
        hint = '${reason}';
    end if;
`;
    const check = (row: string): string => {
      const id =
        entry.id === undefined
          ? "null::text"
          : `${row}.${quoteIdent(entry.id)}::text`;
      const customFn = qualified(ctx, ASSIGNMENTS.custom);
      let allowed = `${canAssign}(v_role, ${id})`;
      if (custom && declared !== undefined) {
        const platform = `${customFn}(null, 'global', null, v_role)`;
        allowed =
          entry.id === undefined || entry.tenant === undefined
            ? `case when v_role = any(${declaredArray(declared)}) then ${canAssign}(v_role, ${id}) else ${platform} end`
            : `case when v_role = any(${declaredArray(declared)}) then ${canAssign}(v_role, ${id}) when ${id} is null then ${platform} else ${customFn}(${row}.${quoteIdent(entry.tenant)}::${tenantType}, ${quoteLiteral(entry.scope)}, ${id}, v_role) end`;
      }
      return `    foreach v_role in array array[${rowRoles(entry, row).join(", ")}]::text[] loop
      if v_role is not null and not coalesce(${allowed}, false) then
        raise exception using
          errcode = '42501',
          message = 'permdock: the caller may not assign ' || v_role || ' in ' || coalesce(${id}, 'null'),
          hint = 'not-assignable-by';
      end if;
    end loop;`;
    };
    const what =
      entry.id === undefined ? "global roles" : `${entry.scope} roles`;
    chunks.push(`-- ${entry.table}: a client role may write only the ${what} it may assign${ownUser === undefined ? "" : ", and none on its own rows"}
create or replace function ${fn}()
returns trigger
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_role text;
begin
  if not (${clients}) then
    return coalesce(new, old);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
${ownCheck("old", "self-demotion")}${check("old")}
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
${ownCheck("new", "not-assignable-by")}${check("new")}
  end if;
  return coalesce(new, old);
end;
$$;
revoke execute on function ${fn}() from public, anon, authenticated;
drop trigger if exists "permdock_assignment" on ${table};
create trigger "permdock_assignment"
  before insert or update or delete on ${table}
  for each row execute function ${fn}();`);
  }
  return `${chunks.join("\n\n")}\n`;
}
