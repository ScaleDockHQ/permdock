import type { PermDockConfig } from "../types.ts";
import type { Parts } from "./parts.ts";

import {
  AUTHZ_VERSION_TABLE,
  HOOK_API_SCHEMA,
  hookApiNames,
} from "../../supabase/sources.ts";
import { configError } from "../core/errors.ts";
import { resolveAuthorize } from "../rls/rbac.ts";
import { activeRowSql } from "../sql/active.ts";
import { quoteIdent, quoteLiteral } from "../sql/quote.ts";
import { customRolesOn } from "../sql/shared.ts";
import { entriesSql, typedUsers } from "./memberships.ts";

const SUBJECT_FOR = "subject_for";

/**
 * `subject_for(p_user uuid) returns jsonb`: what the hook would put in a
 * token for `p_user`, from the same membership, role, suspension and version
 * reads, plus the custom roles the user holds when `database` mode keeps them
 * in tables. A backend that only has PostgREST (`postgrestSources`) builds a
 * subject for an acting user or a job from it. Naming the user is why no
 * client role may execute it.
 */
export function subjectForSql(parts: Parts, config: PermDockConfig): string {
  const schema = quoteIdent(parts.schema);
  const fn = `${schema}.${SUBJECT_FOR}`;
  const rows = parts.roles;
  const roles =
    rows === undefined
      ? `  held := '[]'::jsonb;`
      : `  select coalesce(jsonb_agg(distinct ${rows.roleSql} order by ${rows.roleSql}), '[]'::jsonb)
    into held
    from ${rows.from}
    where ${rows.userSql} = v_roles_user;`;
  const suspended =
    parts.users === undefined
      ? ""
      : `
  if not ${activeRowSql(parts.users, "uid")} then
    return jsonb_build_object('id', uid::text, 'active', false);
  end if;`;
  const version = parts.version
    ? `
  select v.version into ver from ${schema}.${quoteIdent(AUTHZ_VERSION_TABLE)} v where v.user_id = uid;
  ver := coalesce(ver, 0);`
    : "";
  const custom =
    customRolesOn(config.rls) && resolveAuthorize(config) === "database"
      ? customRolesOfSql(parts)
      : "";
  return `-- the subject the hook would mint for p_user, for a backend acting for a stored user; no client role may execute it
create or replace function ${fn}(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := p_user;
  held jsonb;
  memberships jsonb;
  custom jsonb := '[]'::jsonb;
  ver bigint;${typedUsers(parts)}
begin
  if uid is null or not exists (select 1 from auth.users u where u.id = uid) then
    return null;
  end if;${suspended}
${roles}
  select coalesce(jsonb_agg(x.entry order by x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text), '[]'::jsonb)
    into memberships
    from (
${entriesSql(parts).replaceAll(/^/gmu, "      ")}
    ) x;${custom}${version}
  return jsonb_strip_nulls(jsonb_build_object(
    'id', uid::text,
    'active', true,
    'roles', held,
    'memberships', memberships,
    'customRoles', custom,
    'authzVersion', ver
  ));
end;
$$;
revoke execute on function ${fn}(uuid) from public, anon, authenticated;`;
}

/**
 * The PostgREST wrappers `supabase.hook.api` asks for: one `security definer`
 * function per reader, in the API schema, executable by `service_role` only.
 */
export function apiWrappersSql(parts: Parts): string {
  const api = parts.hook.api;
  if (api === undefined) {
    return "";
  }
  const target = api.schema ?? HOOK_API_SCHEMA;
  const names = hookApiNames(api.prefix);
  const source = quoteIdent(parts.schema);
  const wrapper = (
    name: string,
    inner: string,
    params: string,
    args: string,
    types: string,
    returns: string,
  ): string => {
    const fn = `${quoteIdent(target)}.${quoteIdent(name)}`;
    if (target === parts.schema && name === inner) {
      throw configError(
        `PermDock CLI: supabase.hook.api would replace ${source}.${inner}: set api.schema or api.prefix`,
      );
    }
    return `create or replace function ${fn}(${params})
returns ${returns}
language sql
stable
security definer
set search_path = ''
as $$ select ${source}.${inner}(${args}) $$;
revoke execute on function ${fn}(${types}) from public, anon, authenticated;
grant execute on function ${fn}(${types}) to service_role;`;
  };
  return `-- supabase.hook.api: wrappers in ${quoteIdent(target)} for a backend that reaches the hook schema through the Data API; only service_role may execute them
${wrapper(names.subjectFor, SUBJECT_FOR, "p_user uuid", "p_user", "uuid", "jsonb")}

${wrapper(names.membersOf, MEMBERS_OF, "p_scope text, p_id text", "p_scope, p_id", "text, text", "jsonb")}

${wrapper(names.authzVersionFor, AUTHZ_VERSION_FOR, "p_user uuid", "p_user", "uuid", "bigint")}`;
}

const AUTHZ_VERSION_FOR = "authz_version_for";

/**
 * `authz_version_for(p_user uuid) returns bigint`: the authorization version
 * `subject_for` reports, without reading roles or memberships, so a
 * `claimsFirst` reread can check a token's freshness on every request and read
 * the full subject only when it is behind. `null` for an unknown or suspended
 * user, and when the version is off.
 */
export function authzVersionForSql(parts: Parts): string {
  const schema = quoteIdent(parts.schema);
  const fn = `${schema}.${AUTHZ_VERSION_FOR}`;
  const suspended =
    parts.users === undefined
      ? ""
      : `
  if not ${activeRowSql(parts.users, "uid")} then
    return null;
  end if;`;
  const version = parts.version
    ? `
  select v.version into ver from ${schema}.${quoteIdent(AUTHZ_VERSION_TABLE)} v where v.user_id = uid;
  ver := coalesce(ver, 0);`
    : "";
  return `-- the authorization version subject_for reports for p_user, for a cheap freshness check; no client role may execute it
create or replace function ${fn}(p_user uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := p_user;
  ver bigint;
begin
  if uid is null or not exists (select 1 from auth.users u where u.id = uid) then
    return null;
  end if;${suspended}${version}
  return ver;
end;
$$;
revoke execute on function ${fn}(uuid) from public, anon, authenticated;`;
}

const MEMBERS_OF = "members_of";

export function membersOfSql(parts: Parts): string {
  const fn = `${quoteIdent(parts.schema)}.${MEMBERS_OF}`;
  const keep = parts.sources.some((source) => source.sql.keeps);
  const rows = parts.sources
    .map((source) => source.sql.list(keep).replaceAll(/^/gmu, "      "))
    .join("\n      union all\n");
  return `-- the live memberships of one scope instance, for a backend that lists members over PostgREST; no client role may execute it
create or replace function ${fn}(p_scope text, p_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'principal', jsonb_build_object('id', s.user_id),
      'membership', jsonb_strip_nulls(jsonb_build_object(
        'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
        'expires_at', s.expires_at, 'granted_by', s.granted_by, 'reason', s.reason,
        'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
        'managed_by', s.managed_by, 'entitlements', s.seats${keep ? ", 'keep', s.keep" : ""}
      ))
    ) order by s.user_id, s.roles::text), '[]'::jsonb)
  from (
${rows}
  ) s
$$;
revoke execute on function ${fn}(text, text) from public, anon, authenticated;`;
}

/**
 * The custom roles `p_user` holds: tenant and shared roles named on a
 * membership of the scope (and instance) they live at, and platform roles
 * among the global roles, each with its grants and includes in `CustomRole`
 * form. A shadowed tenant role comes along; `resolveCustomRole`'s callers drop it.
 */
function customRolesOfSql(parts: Parts): string {
  const helpers = quoteIdent(parts.helpers.schema);
  const perms = `${helpers}.custom_role_permissions`;
  const includes = `${helpers}.custom_role_includes`;
  const root = quoteLiteral(parts.root);
  const match = `p.tenant_id is not distinct from c.tenant_id and p.scope = c.scope and p.scope_id is not distinct from c.scope_id and p.role = c.role`;
  return `
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'name', c.role,
      'shared', case when c.tenant_id is null and c.scope <> 'global' then true end,
      'tenant', c.tenant_id::text,
      'scope', c.scope,
      'id', c.scope_id,
      'grants', (
        select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'permission', p.permission,
            'effect', p.effect,
            'level', to_jsonb(p) ->> 'level'
          )) order by p.permission, p.effect), '[]'::jsonb)
        from ${perms} p
        where ${match}
      ),
      'includes', (
        select jsonb_agg(p.include_role order by p.include_role)
        from ${includes} p
        where ${match}
      )
    )) order by c.tenant_id::text, c.scope, c.scope_id, c.role), '[]'::jsonb)
    into custom
    from (
      select tenant_id, scope, scope_id, role from ${perms}
      union
      select tenant_id, scope, scope_id, role from ${includes}
    ) c
    where (c.scope = 'global' and c.tenant_id is null and held ? c.role)
      or exists (
        select 1
        from jsonb_array_elements(memberships) m
        where m -> 'roles' ? c.role
          and m ->> 'scope' = c.scope
          and (
            (c.tenant_id is null and c.scope_id is null)
            or c.tenant_id::text = case when m ->> 'scope' = ${root} then m ->> 'id' else m -> 'within' ->> ${root} end
          )
          and (c.scope_id is null or c.scope_id = m ->> 'id')
      );`;
}
