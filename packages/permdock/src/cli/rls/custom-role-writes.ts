import type { RlsSqlContext } from "../sql/context.ts";

import { sqlTextArray } from "../../core/sql.ts";
import { byKey } from "../shared/compare.ts";
import { tenantTypeOf } from "../sql/columns.ts";
import {
  memberForHelper,
  memberIdsHelper,
  permittedForHelper,
  permittedIdsHelper,
} from "../sql/names.ts";
import { qualified, quoteLiteral } from "../sql/quote.ts";
import { allowEntry, CUSTOM_ROLES, HELPERS, signedIn } from "../sql/shared.ts";
import { subjectIdSql } from "../sql/subject.ts";
import {
  currentKeyExpr,
  hasCustomRoleChecksFor,
  perScope,
  raiseSql,
  storedTenant,
} from "./custom-roles.ts";

function callerFunctionsSql(
  ctx: RlsSqlContext,
  custom: NonNullable<RlsSqlContext["customRoles"]>,
  root: string,
  levelReach: readonly (readonly [string, string])[],
  forUser: boolean,
): { readonly beyond: string; readonly guard: string } {
  const leveled = custom.levels === true;
  const tenantType = tenantTypeOf(ctx);
  const rp = qualified(ctx, "role_permissions");
  const keys = qualified(ctx, CUSTOM_ROLES.keys);
  const perms = qualified(ctx, CUSTOM_ROLES.permissions);
  const includes = qualified(ctx, CUSTOM_ROLES.includes);
  const shape = qualified(ctx, CUSTOM_ROLES.shape);
  const beyond = qualified(
    ctx,
    forUser ? CUSTOM_ROLES.beyondFor : CUSTOM_ROLES.beyond,
  );
  const guard = qualified(
    ctx,
    forUser ? CUSTOM_ROLES.guardFor : CUSTOM_ROLES.guard,
  );
  const user = forUser ? "p_user" : subjectIdSql(ctx);
  const userParam = forUser ? "p_user uuid, " : "";
  const userArg = forUser ? "uuid, " : "";
  const userCall = forUser ? "p_user, " : "";
  const has = (key: string): string =>
    forUser
      ? `${qualified(ctx, HELPERS.hasFor)}(p_user, ${key})`
      : `${qualified(ctx, HELPERS.has)}(${key})`;
  const ids = (helper: string, arg: string): string =>
    `(select x::text from ${qualified(ctx, helper)}(${arg}) x)`;
  const permitted = (scope: string, key: string): string =>
    forUser
      ? ids(permittedForHelper(scope), `p_user, ${key}`)
      : ids(permittedIdsHelper(scope), key);
  const members = (scope: string): string =>
    forUser
      ? ids(memberForHelper(scope), "p_user")
      : ids(memberIdsHelper(scope), "");
  const heldKey = (key: string): string =>
    `(${has(key)}
        or (p_scope <> 'global'
          and (p_tenant::text in ${permitted(root, key)}
            or ${perScope(ctx, (scope) => (scope === root ? "false" : `p_scope_id in ${permitted(scope, key)}`))})))`;
  const holdsAny = (
    permissions: readonly string[],
    held: (key: string) => string,
  ): string =>
    permissions.length === 0
      ? "false"
      : `exists (
    select 1 from ${rp} rp
    where rp.effect = 'allow'
      and rp.permission = any(${sqlTextArray(permissions)})
      and ${held("rp.grant_key")}
  )`;
  const manageKeys = custom.manage ?? [];
  const manage = holdsAny(manageKeys, heldKey);
  const platform = holdsAny(manageKeys, has);
  const requires =
    custom.requires === undefined
      ? ""
      : `
  if not ${holdsAny(custom.requires, heldKey)} then
${raiseSql("    ", "42501", `'permdock: the caller may not manage roles in ' || coalesce(p_tenant::text, 'the platform')`, "manage-roles")}
  end if;`;
  const reachRows = levelReach
    .map(
      ([grantKey, level]) =>
        `(${quoteLiteral(grantKey)}, ${quoteLiteral(level)})`,
    )
    .join(", ");
  const levelCheck =
    leveled && reachRows !== ""
      ? `
      or exists (
        select 1
        from reach x
        where x.grant_key = r.grant_key
          and not exists (
            select 1 from held h
            join reach o on o.grant_key = h.grant_key
            where h.permission = r.permission and o.level = x.level
          )
      )`
      : "";
  const reachCte =
    leveled && reachRows !== ""
      ? `,
    reach (grant_key, level) as (values ${reachRows})`
      : "";
  const match = `${storedTenant(ctx)} and c.scope = p_scope and c.scope_id is not distinct from p_scope_id`;
  const memberOf = `p_tenant::text in ${members(root)}
      or ${perScope(ctx, (scope) => (scope === root ? "false" : `p_scope_id in ${members(scope)}`))}`;
  return {
    beyond: `-- custom-role writes: the permission keys of a definition the caller may not hand out in the tenant, as assignablePermissions computes them
create or replace function ${beyond}(${userParam}p_tenant ${tenantType}, p_scope text, p_scope_id text, p_allow text[], p_deny text[], p_include text[])
returns setof text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if ${manage} then
    return;
  end if;
  return query
  with resolved as (
    select distinct rp.permission, k.key as grant_key
    from ${keys}(p_allow, p_deny, p_include, p_scope) k(key)
    join ${rp} rp on rp.grant_key = k.key and rp.effect = 'allow'
  ),
  held as (
    select distinct rp.permission, rp.grant_key
    from ${rp} rp
    where rp.effect = 'allow'
      and rp.permission in (select r.permission from resolved r)
      and ${heldKey("rp.grant_key")}
  )${reachCte}
  select distinct r.permission
  from resolved r
  where not exists (select 1 from held h where h.permission = r.permission)${levelCheck};
end;
$$;
revoke execute on function ${beyond}(${userArg}${tenantType}, text, text, text[], text[], text[]) from public, anon, authenticated;`,
    guard: `-- a custom role the caller may change: membership of the tenant or the instance (a platform role, or a caller holding a manageRoles permission through a global role, needs none), and authority over the stored definition
create or replace function ${guard}(${userParam}p_tenant ${tenantType}, p_scope text, p_scope_id text, p_role text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_allow text[];
  v_deny text[];
  v_include text[];
  v_beyond text;
begin
  perform ${shape}(p_tenant, p_scope, p_scope_id, p_role);
  if not (${signedIn(ctx, user)} and (
    ${platform}
    or (p_scope <> 'global' and coalesce(${memberOf}, false))
  )) then
${raiseSql("    ", "42501", `'permdock: the caller is not a member of ' || coalesce(p_tenant::text, 'the platform')`, "not-member")}
  end if;${requires}
  select array_agg(${allowEntry(ctx)}) filter (where c.effect = 'allow'),
    array_agg(c.permission) filter (where c.effect = 'deny')
  into v_allow, v_deny
  from ${perms} c
  where ${match} and c.role = p_role;
  select array_agg(c.include_role) into v_include
  from ${includes} c
  where ${match} and c.role = p_role;
  select string_agg(b, ', ' order by b) into v_beyond
  from ${beyond}(${userCall}p_tenant, p_scope, p_scope_id, v_allow, v_deny, v_include) b;
  if v_beyond is not null then
${raiseSql("    ", "42501", `'permdock: ' || p_role || ' allows ' || v_beyond || ', which the caller may not hand out'`, "not-assignable-by")}
  end if;
end;
$$;
revoke execute on function ${guard}(${userArg}${tenantType}, text, text, text) from public, anon, authenticated;`,
  };
}

/**
 * The functions an application calls to save, rename and delete a custom role
 * in \`database\` mode, with the rules of \`validateCustomRole\` and
 * \`assignablePermissions\`: entries inside the ceiling of the role's scope,
 * includes naming declared roles, and only permissions and levels the caller
 * may hand out, for the new definition and the stored one alike. A platform
 * custom role (\`p_scope = 'global'\`, no tenant) and a shared custom role (no
 * tenant at a lower scope) are written by a caller who holds a
 * \`meta.manageRoles\` permission through a global role. The
 * \`permdock_trusted_*\` variants skip the caller checks and keep the
 * definition checks; no client role may execute them.
 */
export function customRoleWritesSql(
  ctx: RlsSqlContext,
  levelReach: readonly (readonly [string, string])[],
): string {
  const custom = ctx.customRoles;
  const root = ctx.scopes[0]?.name;
  if (
    custom === undefined ||
    ctx.authorize !== "database" ||
    root === undefined
  ) {
    return "";
  }
  const leveled = custom.levels === true;
  const tenantType = tenantTypeOf(ctx);
  const rp = qualified(ctx, "role_permissions");
  const ceiling = qualified(ctx, CUSTOM_ROLES.ceiling);
  const perms = qualified(ctx, CUSTOM_ROLES.permissions);
  const includes = qualified(ctx, CUSTOM_ROLES.includes);
  const beyond = qualified(ctx, CUSTOM_ROLES.beyond);
  const guard = qualified(ctx, CUSTOM_ROLES.guard);
  const shape = qualified(ctx, CUSTOM_ROLES.shape);
  const entries = qualified(ctx, CUSTOM_ROLES.entries);
  const problem = qualified(ctx, CUSTOM_ROLES.entryProblem);
  const renames = Object.entries(custom.renamed ?? {}).toSorted(byKey);
  const current = (expr: string): string => currentKeyExpr(renames, expr);
  const known = sqlTextArray([
    ...(custom.permissions ?? []),
    ...renames.map(([former]) => former),
  ]);
  const caller = callerFunctionsSql(ctx, custom, root, levelReach, false);
  const match = `c.tenant_id is not distinct from p_tenant and c.scope = p_scope and c.scope_id is not distinct from p_scope_id`;
  const scopes = sqlTextArray(ctx.scopes.map((scope) => scope.name));
  const roleName = (param: string): string =>
    `coalesce(${param}, '') = '' or ${param} = any(${sqlTextArray(custom.declared)})`;
  const levelOf = leveled ? ", nullif(split_part(e, '@', 2), '')" : "";
  const levelColumn = leveled ? ", level" : "";
  const sharedRole = qualified(ctx, CUSTOM_ROLES.shared);
  const taken = (
    param: string,
  ): string => `  if p_tenant is not null and ${sharedRole}(p_scope, ${param}) then
${raiseSql("    ", "22023", `'permdock: ' || ${param} || ' is the name of a shared custom role'`, "name-taken")}
  end if;
`;
  const write = `${taken("p_role")}  delete from ${perms} c where ${match} and c.role = p_role;
  delete from ${includes} c where ${match} and c.role = p_role;
  insert into ${perms} (tenant_id, scope, scope_id, role, permission, effect${levelColumn})
  select distinct p_tenant, p_scope, p_scope_id, p_role, ${current(leveled ? "split_part(e, '@', 1)" : "e")}, 'allow'${levelOf}
  from unnest(coalesce(p_allow, '{}'::text[])) e
  union
  select distinct p_tenant, p_scope, p_scope_id, p_role, ${current("e")}, 'deny'${leveled ? ", null" : ""}
  from unnest(coalesce(p_deny, '{}'::text[])) e;
  insert into ${includes} (tenant_id, scope, scope_id, role, include_role)
  select distinct p_tenant, p_scope, p_scope_id, p_role, e
  from unnest(coalesce(p_include, '{}'::text[])) e;`;
  const move = `${taken("p_to")}  if ${roleName("p_to")} then
${raiseSql("    ", "22023", `'permdock: ' || coalesce(p_to, 'null') || ' is not a custom role name'`, "declared-role")}
  end if;
  if exists (select 1 from ${perms} c where ${match} and c.role = p_to)
    or exists (select 1 from ${includes} c where ${match} and c.role = p_to) then
${raiseSql("    ", "22023", `'permdock: ' || p_to || ' already has grants'`, "role-exists")}
  end if;
  update ${perms} c set role = p_to where ${match} and c.role = p_from;
  update ${includes} c set role = p_to where ${match} and c.role = p_from;`;
  const remove = `  delete from ${perms} c where ${match} and c.role = p_role;
  delete from ${includes} c where ${match} and c.role = p_role;`;
  const writeArgs = `${tenantType}, text, text, text, text[], text[], text[]`;
  const renameArgs = `${tenantType}, text, text, text, text`;
  const removeArgs = `${tenantType}, text, text, text`;
  const fn = (
    comment: string,
    name: string,
    params: string,
    args: string,
    body: string,
    member: boolean,
  ): string => `-- ${comment}
create or replace function ${qualified(ctx, name)}(${params})
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
${body}
$$;
${
  member
    ? `revoke execute on function ${qualified(ctx, name)}(${args}) from public, anon;
grant execute on function ${qualified(ctx, name)}(${args}) to authenticated;`
    : `revoke execute on function ${qualified(ctx, name)}(${args}) from public, anon, authenticated;`
}`;
  const writeParams = `p_tenant ${tenantType}, p_scope text, p_scope_id text, p_role text, p_allow text[], p_deny text[], p_include text[]`;
  const renameParams = `p_tenant ${tenantType}, p_scope text, p_scope_id text, p_from text, p_to text`;
  const removeParams = `p_tenant ${tenantType}, p_scope text, p_scope_id text, p_role text`;
  return `${caller.beyond}

-- where a custom role may live: a scope of a tenant, a scope of every tenant (shared: no tenant or instance), or the platform (scope global, no tenant or instance), under an undeclared name
create or replace function ${shape}(p_tenant ${tenantType}, p_scope text, p_scope_id text, p_role text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_scope = 'global' then
    if p_tenant is not null or p_scope_id is not null then
${raiseSql("      ", "22023", `'permdock: a platform custom role has no tenant or instance'`, "unknown-scope")}
    end if;
  elsif not (p_scope = any(${scopes})) then
${raiseSql("    ", "22023", `'permdock: custom roles are held at a scope of a tenant or at global, not ' || coalesce(p_scope, 'null')`, "unknown-scope")}
  elsif p_tenant is null and p_scope_id is not null then
${raiseSql("    ", "22023", `'permdock: a shared custom role has no instance'`, "unknown-scope")}
  end if;
  if ${roleName("p_role")} then
${raiseSql("    ", "22023", `'permdock: ' || coalesce(p_role, 'null') || ' is not a custom role name'`, "declared-role")}
  end if;
end;
$$;
revoke execute on function ${shape}(${tenantType}, text, text, text) from public, anon, authenticated;

${caller.guard}
${
  hasCustomRoleChecksFor(ctx)
    ? `
-- the same checks for a user the caller names: trusted SQL acting later for a stored user; no client role may execute them
${callerFunctionsSql(ctx, custom, root, levelReach, true).beyond}

${callerFunctionsSql(ctx, custom, root, levelReach, true).guard}
`
    : ""
}
-- null when an allow entry is a declared permission inside the ceiling of the scope${leveled ? ", at a level the resource declares" : ""}; else unknown-permission, outside-ceiling${leveled ? " or unknown-level" : ""}
create or replace function ${problem}(p_scope text, p_entry text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key text := ${current(leveled ? "split_part(p_entry, '@', 1)" : "p_entry")};
begin
  if p_entry is null or not (v_key = any(${known})) then
    return 'unknown-permission';
  end if;
  if not exists (
    select 1 from ${ceiling} c
    where c.scope = p_scope and c.effect = 'allow' and ${current("c.permission")} = v_key
  ) then
    return 'outside-ceiling';
  end if;${
    leveled
      ? `
  if strpos(p_entry, '@') > 0 and not exists (
    select 1 from ${ceiling} c
    where c.scope = p_scope and c.effect = 'allow' and ${current("c.permission")} = v_key
      and split_part(c.grant_key, '@', 2) = split_part(p_entry, '@', 2)
  ) then
    return 'unknown-level';
  end if;`
      : ""
  }
  return null;
end;
$$;
revoke execute on function ${problem}(text, text) from public, anon, authenticated;

-- the entries of a definition: declared keys and levels inside the ceiling of the scope, and declared includes
create or replace function ${entries}(p_scope text, p_allow text[], p_deny text[], p_include text[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_entry text;
  v_key text;
  v_problem text;
begin
  foreach v_entry in array coalesce(p_allow, '{}'::text[]) loop
    v_key := ${current(leveled ? "split_part(v_entry, '@', 1)" : "v_entry")};
    v_problem := ${problem}(p_scope, v_entry);
    if v_problem = 'unknown-permission' then
${raiseSql("      ", "22023", `'permdock: ' || v_entry || ' is not a declared permission'`, "unknown-permission")}
    end if;
    if v_problem = 'outside-ceiling' then
${raiseSql("      ", "22023", `'permdock: ' || v_key || ' is outside the ceiling of ' || p_scope`, "outside-ceiling")}
    end if;${
      leveled
        ? `
    if v_problem = 'unknown-level' then
${raiseSql("      ", "22023", `'permdock: ' || v_entry || ' names a level the resource does not declare'`, "unknown-level")}
    end if;`
        : ""
    }
  end loop;
  foreach v_entry in array coalesce(p_deny, '{}'::text[]) loop
    if not (v_entry = any(${known})) then
${raiseSql("      ", "22023", `'permdock: ' || v_entry || ' is not a declared permission'`, "unknown-permission")}
    end if;
  end loop;
  foreach v_entry in array coalesce(p_include, '{}'::text[]) loop
    if not (v_entry = any(${sqlTextArray(custom.declared)})) then
${raiseSql("      ", "22023", `'permdock: ' || v_entry || ' is not a declared role'`, "unknown-role")}
    end if;
  end loop;
  select string_agg(distinct ${current("rp.permission")}, ', ') into v_key
  from ${rp} rp
  where rp.role = any(coalesce(p_include, '{}'::text[]))
    and rp.effect = 'allow'
    and not exists (
      select 1 from ${ceiling} c
      where c.scope = p_scope and c.effect = 'allow' and ${current("c.permission")} = ${current("rp.permission")}
    );
  if v_key is not null then
${raiseSql("    ", "22023", `'permdock: an included role allows ' || v_key || ', outside the ceiling of ' || p_scope`, "outside-ceiling")}
  end if;
end;
$$;
revoke execute on function ${entries}(text, text[], text[], text[]) from public, anon, authenticated;

${fn(
  "save a custom role: replace its grants and includes after checking each entry against the ceiling and the caller's own permissions",
  CUSTOM_ROLES.replace,
  writeParams,
  writeArgs,
  `declare
  v_beyond text;
begin
  perform ${guard}(p_tenant, p_scope, p_scope_id, p_role);
  perform ${entries}(p_scope, p_allow, p_deny, p_include);
  select string_agg(b, ', ' order by b) into v_beyond
  from ${beyond}(p_tenant, p_scope, p_scope_id, p_allow, p_deny, p_include) b;
  if v_beyond is not null then
${raiseSql("    ", "42501", `'permdock: ' || p_role || ' would allow ' || v_beyond || ', which the caller may not hand out'`, "not-assignable-by")}
  end if;
${write}
end;`,
  true,
)}

${fn(
  "rename a custom role: move its grants and includes to the new name",
  CUSTOM_ROLES.rename,
  renameParams,
  renameArgs,
  `begin
  perform ${guard}(p_tenant, p_scope, p_scope_id, p_from);
${move}
end;`,
  true,
)}

${fn(
  "delete a custom role: remove its grants and includes",
  CUSTOM_ROLES.remove,
  removeParams,
  removeArgs,
  `begin
  perform ${guard}(p_tenant, p_scope, p_scope_id, p_role);
${remove}
end;`,
  true,
)}

${fn(
  "save a custom role for a trusted caller (a migration, a job, a backend role granted execute): the definition checks without the caller checks",
  CUSTOM_ROLES.trustedReplace,
  writeParams,
  writeArgs,
  `begin
  perform ${shape}(p_tenant, p_scope, p_scope_id, p_role);
  perform ${entries}(p_scope, p_allow, p_deny, p_include);
${write}
end;`,
  false,
)}

${fn(
  "rename a custom role for a trusted caller",
  CUSTOM_ROLES.trustedRename,
  renameParams,
  renameArgs,
  `begin
  perform ${shape}(p_tenant, p_scope, p_scope_id, p_from);
${move}
end;`,
  false,
)}

${fn(
  "delete a custom role for a trusted caller",
  CUSTOM_ROLES.trustedRemove,
  removeParams,
  removeArgs,
  `begin
  perform ${shape}(p_tenant, p_scope, p_scope_id, p_role);
${remove}
end;`,
  false,
)}`;
}
