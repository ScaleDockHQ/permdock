import type { RlsSqlContext } from "../sql/context.ts";

import { tenantTypeOf } from "../sql/columns.ts";
import { qualified, quoteLiteral } from "../sql/quote.ts";
import { CUSTOM_ROLES, allowEntry } from "../sql/shared.ts";

/** The event name of a tenant's custom-role version message. */
const CUSTOM_ROLES_EVENT = "custom_roles";

/** `authz-tenant:<tenant>`, the topic one message per edited tenant goes to. */
const CUSTOM_ROLES_TENANT_TOPIC = "authz-tenant:";

function tenantMatch(alias: string): string {
  return `(p_tenant is null and ${alias}.tenant_id is null or ${alias}.tenant_id = p_tenant)`;
}

function roleMatch(alias: string): string {
  return `${tenantMatch(alias)} and ${alias}.scope = p_scope and ${alias}.role = p_role`;
}

function trigger(
  table: string,
  suffix: string,
  event: "insert" | "update" | "delete",
  fn: string,
): string {
  const name = `permdock_custom_roles_compile_${suffix}_${event}`;
  const referencing =
    event === "insert"
      ? "referencing new table as permdock_new"
      : event === "delete"
        ? "referencing old table as permdock_old"
        : "referencing old table as permdock_old new table as permdock_new";
  return `drop trigger if exists "${name}" on ${table};
create trigger "${name}"
  after ${event} on ${table}
  ${referencing}
  for each statement execute function ${fn}();`;
}

function touched(source: string): string {
  return `select array_agg(t.tenant_id), array_agg(t.scope), array_agg(t.role) from (select distinct tenant_id, scope, role from ${source}) t`;
}

/**
 * `database` mode: the tables a custom-role edit maintains from statement
 * triggers, so no policy or read resolves a role at query time.
 *
 * - `custom_role_version (tenant_id, version)`: one counter per tenant, and one
 *   row with a null tenant for the shared and platform roles. One edit
 *   statement bumps each tenant it touched once.
 * - `custom_role_compiled`: one row per stored role (and per instance it is
 *   pinned to), holding the grant keys `permdock_custom_keys` resolves, the
 *   grants in `CustomRole` form and the includes.
 *
 * A pinned row merges the rows with no instance, so a probe reads the pinned
 * row when there is one and the unpinned row otherwise.
 */
export function customRoleCompiledSql(ctx: RlsSqlContext): string {
  const custom = ctx.customRoles;
  if (custom === undefined || ctx.authorize !== "database") {
    return "";
  }
  const tenantType = tenantTypeOf(ctx);
  const perms = qualified(ctx, CUSTOM_ROLES.permissions);
  const includes = qualified(ctx, CUSTOM_ROLES.includes);
  const compiled = qualified(ctx, CUSTOM_ROLES.compiled);
  const versions = qualified(ctx, CUSTOM_ROLES.versions);
  const keys = qualified(ctx, CUSTOM_ROLES.keys);
  const compile = qualified(ctx, CUSTOM_ROLES.compile);
  const compileFor = qualified(ctx, CUSTOM_ROLES.compileFor);
  const recompile = qualified(ctx, CUSTOM_ROLES.recompile);
  const entry = `c.${allowEntry(ctx)}`;
  const broadcast = custom.broadcast;
  const send =
    broadcast === undefined
      ? ""
      : `
  if to_regprocedure('realtime.send(jsonb, text, text, boolean)') is not null then
    for r in
      select v.tenant_id, v.version from ${versions} v
      where v.tenant_id in (select u from unnest(p_owners) u)
        or (v.tenant_id is null and exists (select 1 from unnest(p_owners) u where u is null))
    loop
      perform realtime.send(
        jsonb_build_object('tenant', r.tenant_id, 'version', r.version),
        ${quoteLiteral(CUSTOM_ROLES_EVENT)}::text,
        (case when r.tenant_id is null then ${quoteLiteral(broadcast.topic)} else ${quoteLiteral(CUSTOM_ROLES_TENANT_TOPIC)} || r.tenant_id::text end)::text,
        true
      );
    end loop;
  end if;`;
  const handler = (event: "insert" | "update" | "delete"): string => {
    const fn = qualified(ctx, `${CUSTOM_ROLES.compileStatement}_${event}`);
    const body =
      event === "insert"
        ? touched("permdock_new")
        : event === "delete"
          ? touched("permdock_old")
          : `select array_agg(t.tenant_id), array_agg(t.scope), array_agg(t.role)
    from (select tenant_id, scope, role from permdock_old union select tenant_id, scope, role from permdock_new) t`;
    return `create or replace function ${fn}()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_owners ${tenantType}[];
  v_scopes text[];
  v_roles text[];
begin
  ${body}
  into v_owners, v_scopes, v_roles;
  perform ${compileFor}(v_owners, v_scopes, v_roles);
  return null;
end;
$$;
revoke execute on function ${fn}() from public, anon, authenticated;`;
  };
  return `-- the compiled custom roles: the keys of each stored role, written when it is saved and read by the policies and by subject_for
create table if not exists ${versions} (
  tenant_id ${tenantType},
  version bigint not null default 0
);
-- the row with no tenant counts the shared and platform roles
create unique index if not exists ${CUSTOM_ROLES.versions}_key on ${versions} (tenant_id) nulls not distinct;
alter table ${versions} enable row level security;
revoke all on table ${versions} from anon, authenticated, public;

create table if not exists ${compiled} (
  tenant_id ${tenantType},
  scope text not null,
  scope_id text,
  role text not null,
  grant_keys text[] not null default '{}',
  grants jsonb not null default '[]'::jsonb,
  includes text[] not null default '{}',
  version bigint not null default 0
);
create unique index if not exists ${CUSTOM_ROLES.compiled}_role_key on ${compiled} (tenant_id, scope, role, scope_id) nulls not distinct;
alter table ${compiled} enable row level security;
revoke all on table ${compiled} from anon, authenticated, public;

-- one stored role, compiled: a row per instance it is pinned to, each merged with the rows that name no instance
create or replace function ${compile}(p_tenant ${tenantType}, p_scope text, p_role text, p_version bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from ${compiled} c
  where (p_tenant is null and c.tenant_id is null or c.tenant_id = p_tenant) and c.scope = p_scope and c.role = p_role;
  insert into ${compiled} (tenant_id, scope, scope_id, role, grant_keys, grants, includes, version)
  select p_tenant, p_scope, pin.scope_id, p_role,
    array(select k from ${keys}(e.allow, e.deny, e.incl, p_scope) k order by 1),
    own.grants, own.incl, p_version
  from (
    select c.scope_id from ${perms} c where ${roleMatch("c")}
    union
    select c.scope_id from ${includes} c where ${roleMatch("c")}
  ) pin
  cross join lateral (
    select
      coalesce(array_agg(${entry} order by ${entry}) filter (where c.effect = 'allow'), '{}'::text[]) as allow,
      coalesce(array_agg(c.permission order by c.permission) filter (where c.effect = 'deny'), '{}'::text[]) as deny,
      array(
        select i.include_role from ${includes} i
        where ${roleMatch("i")} and (i.scope_id is null or i.scope_id = pin.scope_id)
        order by 1
      ) as incl
    from ${perms} c
    where ${roleMatch("c")} and (c.scope_id is null or c.scope_id = pin.scope_id)
  ) e
  cross join lateral (
    select
      coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'permission', c.permission, 'effect', c.effect, 'level', to_jsonb(c) ->> 'level'
      )) order by c.permission, c.effect), '[]'::jsonb) as grants,
      array(
        select i.include_role from ${includes} i
        where ${roleMatch("i")} and i.scope_id is not distinct from pin.scope_id
        order by 1
      ) as incl
    from ${perms} c
    where ${roleMatch("c")} and c.scope_id is not distinct from pin.scope_id
  ) own;
end;
$$;
revoke execute on function ${compile}(${tenantType}, text, text, bigint) from public, anon, authenticated;

-- the roles a statement touched: one version bump per tenant, then each role compiled at the new version
create or replace function ${compileFor}(p_owners ${tenantType}[], p_scopes text[], p_roles text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
begin
  insert into ${versions} as v (tenant_id, version)
  select distinct u, 1 from unnest(p_owners) u
  on conflict (tenant_id) do update set version = v.version + 1;
  for r in
    select distinct u.own_id, u.scope, u.role, (
      select v.version from ${versions} v where v.tenant_id is not distinct from u.own_id
    ) as version
    from unnest(p_owners, p_scopes, p_roles) u(own_id, scope, role)
  loop
    perform ${compile}(r.own_id, r.scope, r.role, r.version);
  end loop;${send}
end;
$$;
revoke execute on function ${compileFor}(${tenantType}[], text[], text[]) from public, anon, authenticated;

${handler("insert")}

${handler("update")}

${handler("delete")}

${[perms, includes]
  .map((table, index) =>
    (["insert", "update", "delete"] as const)
      .map((event) =>
        trigger(
          table,
          index === 0 ? "permissions" : "includes",
          event,
          qualified(ctx, `${CUSTOM_ROLES.compileStatement}_${event}`),
        ),
      )
      .join("\n"),
  )
  .join("\n")}

-- compiles every stored role again, for the first run after an upgrade or a change to the declared roles
create or replace function ${recompile}()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from ${compiled};
  perform ${compileFor}(
    array(select t.tenant_id from (select distinct tenant_id, scope, role from ${perms} union select tenant_id, scope, role from ${includes}) t order by t.tenant_id, t.scope, t.role),
    array(select t.scope from (select distinct tenant_id, scope, role from ${perms} union select tenant_id, scope, role from ${includes}) t order by t.tenant_id, t.scope, t.role),
    array(select t.role from (select distinct tenant_id, scope, role from ${perms} union select tenant_id, scope, role from ${includes}) t order by t.tenant_id, t.scope, t.role)
  );
end;
$$;
revoke execute on function ${recompile}() from public, anon, authenticated;`;
}
