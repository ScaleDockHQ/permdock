import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Scope } from '../core/scopes.ts';
import type { SqlMembershipSource } from '../supabase/sources.ts';
import type {
  CliIo,
  PermDockConfig,
  RlsActiveRow,
  SupabaseHookConfig,
} from './types.ts';

import {
  resolveScope,
  rootScope,
  scopeChain,
  scopeList,
} from '../core/scopes.ts';
import {
  AUTHZ_VERSION_TABLE,
  supabaseMembershipsBudget,
} from '../supabase/sources.ts';
import { asPolicy, loadModule, pickNamed } from './load.ts';
import { authAdminRead, hookUri } from './rls-rbac.ts';
import {
  activeRowSql,
  checkSuspension,
  quoteIdent,
  quoteLiteral,
  quoteTable,
} from './rls-sql.ts';

export const SUPABASE_HELP = `permdock supabase hook generate

  hook generate [--out supabase/permdock-hook.sql] [--check]
                [--active-from app_metadata.active_<scope>|<table>.<column>]
                [--budget 1024] [--schema public]

Reads supabase.hook from permdock.config.ts: the fromTable / fromJunction sources the app
passes as memberships. Emits custom_access_token_hook(jsonb), the grants it needs, the
permdock_authz_version table and its triggers. Never grants anything to service_role.
`;

export const MANAGED_TRIGGER = 'permdock_protect_managed';
export const VERSION_TRIGGER = 'permdock_authz_version';

type Parts = {
  readonly schema: string;
  readonly scopes: readonly Scope[];
  readonly root: string;
  readonly sources: readonly SqlMembershipSource[];
  readonly budget: number;
  readonly version: boolean;
  readonly jwtExpiry: number;
  readonly tenantClaim: string;
  readonly users: RlsActiveRow | undefined;
  readonly hook: SupabaseHookConfig;
  readonly active: string;
};

function table(name: string): string {
  return quoteTable(name.includes('.') ? name : `public.${name}`);
}

function positiveInteger(value: unknown, label: string): number {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) {
    throw new Error(`PermDock CLI: ${label} must be a positive integer`);
  }
  return number;
}

/** SQL for the active first-scope id, as text, for user `uid`. */
export function activeFromSql(
  input: SupabaseHookConfig['activeFrom'],
  root: string,
): string {
  const spec = input ?? `app_metadata.active_${root}`;
  if (typeof spec === 'string' && spec.startsWith('app_metadata.')) {
    const key = spec.slice('app_metadata.'.length);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`PermDock CLI: unsafe app_metadata key '${key}'`);
    }
    return `(select u.raw_app_meta_data ->> ${quoteLiteral(key)} from auth.users u where u.id = uid::uuid)`;
  }
  const parsed =
    typeof spec === 'string'
      ? (() => {
          const dot = spec.lastIndexOf('.');
          if (dot <= 0) {
            throw new Error(
              `PermDock CLI: --active-from must be app_metadata.<key> or <table>.<column>, got '${spec}'`,
            );
          }
          return { table: spec.slice(0, dot), column: spec.slice(dot + 1) };
        })()
      : spec;
  const id = 'id' in parsed && parsed.id !== undefined ? parsed.id : 'id';
  return `(select a.${quoteIdent(parsed.column)}::text from ${table(parsed.table)} a where a.${quoteIdent(id)}::text = uid)`;
}

function checkSources(parts: {
  readonly sources: readonly SqlMembershipSource[];
  readonly scopes: readonly Scope[];
  readonly suspended: readonly string[];
}): string[] {
  const warnings: string[] = [];
  if (parts.sources.length === 0) {
    throw new Error(
      'PermDock CLI: supabase.hook.memberships needs at least one fromTable or fromJunction source',
    );
  }
  for (const source of parts.sources) {
    if (source.sql === undefined || typeof source.sql.select !== 'function') {
      throw new Error(
        'PermDock CLI: supabase.hook.memberships takes fromTable / fromJunction sources from permdock/supabase',
      );
    }
    const scope = source.sql.scope;
    if (scope === undefined) {
      continue;
    }
    const name = resolveScope(parts.scopes, scope);
    if (name !== scope) {
      throw new Error(
        `PermDock CLI: the ${source.sql.table} source names scope '${scope}', which the policy does not declare by that name`,
      );
    }
    const chain = scopeChain(parts.scopes, scope);
    const holds = new Set(source.sql.holds ?? [scope]);
    const missing = chain.filter((ancestor) => !holds.has(ancestor));
    if (missing.length > 0) {
      throw new Error(
        `PermDock CLI: the ${source.sql.table} source needs within columns for ${missing.join(', ')}: a ${scope} membership without every ancestor grants nothing`,
      );
    }
    for (const ancestor of chain.slice(1)) {
      if (parts.suspended.includes(ancestor) && !holds.has(ancestor)) {
        warnings.push(
          `the ${source.sql.table} source cannot check ${ancestor} suspension`,
        );
      }
    }
  }
  return warnings;
}

function entriesSql(parts: Parts): string {
  const tenant = `case when s.scope = ${quoteLiteral(parts.root)} then s.id else s.within ->> ${quoteLiteral(parts.root)} end`;
  const selects = parts.sources.map(
    (source, index) => `select ${String(index)} as ord,
  (${tenant}) as tenant,
  jsonb_strip_nulls(jsonb_build_object(
    'scope', s.scope, 'id', s.id, 'within', s.within, 'roles', s.roles, 'via', s.via,
    'expiresAt', s.expires_at, 'managedBy', s.managed_by, 'entitlements', s.seats
  )) as entry
from (
${source.sql.select('uid').replaceAll(/^/gmu, '  ')}
) s`,
  );
  return selects.join('\nunion all\n');
}

function hookSql(parts: Parts): string {
  const schema = quoteIdent(parts.schema);
  const fn = `${schema}.custom_access_token_hook`;
  const rolesTable =
    parts.hook.roles === false
      ? undefined
      : (parts.hook.roles ?? {
          table: `${parts.schema}.user_roles`,
          user: 'user_id',
          role: 'role',
        });
  const roles =
    rolesTable === undefined
      ? `  held := '[]'::jsonb;`
      : `  select coalesce(jsonb_agg(distinct r.${quoteIdent(rolesTable.role ?? 'role')}::text order by r.${quoteIdent(rolesTable.role ?? 'role')}::text), '[]'::jsonb)
    into held
    from ${table(rolesTable.table)} r
    where r.${quoteIdent(rolesTable.user ?? 'user_id')}::text = uid;`;
  const profile = parts.hook.profile;
  const attrs =
    profile === undefined
      ? ''
      : `
  select jsonb_strip_nulls(jsonb_build_object(${profile.columns
    .map(
      (column) => `${quoteLiteral(column)}, to_jsonb(p.${quoteIdent(column)})`,
    )
    .join(', ')}))
    into attrs
    from ${table(profile.table)} p
    where p.${quoteIdent(profile.id ?? 'id')}::text = uid;
  if attrs is not null and attrs <> '{}'::jsonb then
    claims := jsonb_set(claims, '{attrs}', attrs);
  end if;`;
  const versionTable = `${schema}.${quoteIdent(AUTHZ_VERSION_TABLE)}`;
  const version = parts.version
    ? `
  select v.version into ver from ${versionTable} v where v.user_id = uid;
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(coalesce(ver, 0)));`
    : '';
  const suspended =
    parts.users === undefined
      ? ''
      : `
  if not ${activeRowSql(parts.users, 'uid::uuid')} then
    claims := claims - 'memberships_truncated' - ${quoteLiteral(parts.tenantClaim)};
    claims := claims || jsonb_build_object('user_role', '[]'::jsonb, 'roles', '[]'::jsonb, 'memberships', '[]'::jsonb);${version}
    return jsonb_set(event, '{claims}', claims);
  end if;`;
  return `create or replace function ${fn}(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := event -> 'claims';
  uid text := event ->> 'user_id';
  active text;
  held jsonb;
  kept jsonb := '[]'::jsonb;
  truncated boolean := false;
  in_active boolean := false;
  budget integer := ${String(parts.budget)};
  item record;${profile === undefined ? '' : '\n  attrs jsonb;'}${parts.version ? '\n  ver bigint;' : ''}
begin${suspended}
${roles}
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  active := ${parts.active};
  for item in
    select x.entry, x.tenant is not distinct from active as current
    from (
${entriesSql(parts).replaceAll(/^/gmu, '      ')}
    ) x
    order by (x.tenant is not distinct from active) desc, x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text
  loop
    if octet_length((kept || jsonb_build_array(item.entry))::text) > budget then
      truncated := true;
      exit;
    end if;
    kept := kept || jsonb_build_array(item.entry);
    in_active := in_active or (active is not null and item.current);
  end loop;
  claims := jsonb_set(claims, '{memberships}', kept);
  if truncated then
    claims := jsonb_set(claims, '{memberships_truncated}', 'true'::jsonb);
  else
    claims := claims - 'memberships_truncated';
  end if;
  if in_active then
    claims := jsonb_set(claims, ${quoteLiteral(`{${parts.tenantClaim}}`)}, to_jsonb(active));
  end if;${attrs}${version}
  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema ${schema} to supabase_auth_admin;
grant execute on function ${fn}(jsonb) to supabase_auth_admin;
revoke execute on function ${fn}(jsonb) from authenticated, anon, public;`;
}

function readsSql(parts: Parts): string {
  const reads = new Map<string, string>();
  for (const source of parts.sources) {
    reads.set(source.sql.table, 'memberships');
  }
  for (const source of parts.sources) {
    for (const name of source.sql.reads) {
      reads.set(name, reads.get(name) ?? 'status');
    }
  }
  const rolesTable =
    parts.hook.roles === false
      ? undefined
      : (parts.hook.roles?.table ?? `${parts.schema}.user_roles`);
  if (rolesTable !== undefined) {
    reads.set(rolesTable, reads.get(rolesTable) ?? 'roles');
  }
  if (parts.hook.profile !== undefined) {
    reads.set(
      parts.hook.profile.table,
      reads.get(parts.hook.profile.table) ?? 'profile',
    );
  }
  if (parts.users !== undefined) {
    reads.set(
      parts.users.table,
      reads.get(parts.users.table) ?? 'status_users',
    );
  }
  return [...reads]
    .map(([name, label]) => authAdminRead(name, label))
    .join('\n');
}

function versionSql(parts: Parts): string {
  if (!parts.version) {
    return '';
  }
  const schema = quoteIdent(parts.schema);
  const versionTable = `${schema}.${quoteIdent(AUTHZ_VERSION_TABLE)}`;
  const bump = `${schema}.permdock_bump_authz_version`;
  const tables = [
    ...new Map(
      parts.sources.map((source) => [source.sql.table, source.sql.user]),
    ),
  ];
  const rolesTable =
    parts.hook.roles === false
      ? undefined
      : (parts.hook.roles ?? { table: `${parts.schema}.user_roles` });
  if (rolesTable !== undefined) {
    tables.push([rolesTable.table, rolesTable.user ?? 'user_id']);
  }
  const triggers = tables
    .map(
      ([
        name,
        user,
      ]) => `drop trigger if exists ${quoteIdent(VERSION_TRIGGER)} on ${table(name)};
create trigger ${quoteIdent(VERSION_TRIGGER)}
  after insert or update or delete on ${table(name)}
  for each row execute function ${bump}(${quoteLiteral(user)});`,
    )
    .join('\n');
  return `-- the authorization version: bumped on every membership change, written to authz_ver
create table if not exists ${versionTable} (
  user_id text primary key,
  version bigint not null default 0
);
alter table ${versionTable} enable row level security;
revoke all on table ${versionTable} from anon, authenticated, public;
${authAdminRead(`${parts.schema}.${AUTHZ_VERSION_TABLE}`, 'version')}

create or replace function ${bump}()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  column_name text := tg_argv[0];
  affected text;
begin
  foreach affected in array array[
    case when tg_op <> 'INSERT' then to_jsonb(old) ->> column_name end,
    case when tg_op <> 'DELETE' then to_jsonb(new) ->> column_name end
  ] loop
    if affected is not null then
      insert into ${versionTable} as v (user_id, version) values (affected, 1)
      on conflict (user_id) do update set version = v.version + 1;
    end if;
  end loop;
  return null;
end;
$$;
revoke execute on function ${bump}() from public, anon, authenticated;
${triggers}`;
}

function managedSql(parts: Parts): string {
  const managed = parts.sources.filter(
    (source) => source.sql.managed !== undefined,
  );
  if (managed.length === 0) {
    return '';
  }
  const schema = quoteIdent(parts.schema);
  const guard = `${schema}.permdock_protect_managed`;
  const triggers = managed
    .map(
      (
        source,
      ) => `drop trigger if exists ${quoteIdent(MANAGED_TRIGGER)} on ${table(source.sql.table)};
create trigger ${quoteIdent(MANAGED_TRIGGER)}
  before insert or update or delete on ${table(source.sql.table)}
  for each row execute function ${guard}(${quoteLiteral(source.sql.managed ?? '')});`,
    )
    .join('\n');
  return `-- memberships the identity provider owns: clients (anon, authenticated) cannot write them
create or replace function ${guard}()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  column_name text := tg_argv[0];
begin
  if current_user in ('anon', 'authenticated') and (
    column_name = ''
    or (tg_op <> 'INSERT' and to_jsonb(old) ->> column_name = 'idp')
    or (tg_op <> 'DELETE' and to_jsonb(new) ->> column_name = 'idp')
  ) then
    raise exception 'PermDock: % rows managed by the identity provider cannot be changed here', tg_table_name
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
${triggers}`;
}

/** The `config.toml` block that enables the hook and bounds token staleness. */
export function configToml(schema: string, jwtExpiry: number): string {
  return `[auth]
jwt_expiry = ${String(jwtExpiry)}

[auth.hook.custom_access_token]
enabled = true
uri = "${hookUri(schema)}"`;
}

export function supabaseHookSql(
  scopes: readonly Scope[],
  config: PermDockConfig,
  overrides: {
    readonly activeFrom?: string;
    readonly budget?: string;
    readonly schema?: string;
  } = {},
): { readonly sql: string; readonly warnings: readonly string[] } {
  const hook = config.supabase?.hook;
  if (hook === undefined) {
    throw new Error(
      'PermDock CLI: supabase hook generate needs supabase.hook in permdock.config.ts',
    );
  }
  const root = rootScope(scopes) ?? 'tenant';
  const suspension = checkSuspension(
    hook.suspension ?? config.rls?.suspension,
    scopes,
  );
  const schema =
    overrides.schema ?? hook.schema ?? config.rls?.schema ?? 'public';
  quoteIdent(schema);
  const parts: Parts = {
    schema,
    scopes,
    root,
    sources: hook.memberships,
    budget: positiveInteger(
      overrides.budget ?? hook.budget ?? supabaseMembershipsBudget,
      'budget',
    ),
    version: hook.version !== false,
    jwtExpiry: positiveInteger(hook.jwtExpiry ?? 900, 'jwtExpiry'),
    tenantClaim: config.rls?.tenantClaim ?? 'tenant_id',
    users: suspension?.users,
    hook,
    active: activeFromSql(overrides.activeFrom ?? hook.activeFrom, root),
  };
  quoteIdent(parts.tenantClaim);
  const warnings = checkSources({
    sources: parts.sources,
    scopes,
    suspended: Object.keys(suspension?.scopes ?? {}),
  });
  const toml = configToml(schema, parts.jwtExpiry)
    .split('\n')
    .map((line) => (line === '' ? '--' : `--   ${line}`))
    .join('\n');
  const sql = [
    `-- permdock supabase hook: custom_access_token_hook(jsonb)
-- claims: user_role, roles, memberships (active ${root} first, at most ${String(parts.budget)} bytes; memberships_truncated when cut), ${parts.tenantClaim}${hook.profile === undefined ? '' : ', attrs'}${parts.version ? ', authz_ver' : ''}
-- supabase/config.toml:
${toml}`,
    hookSql(parts),
    readsSql(parts),
    versionSql(parts),
    managedSql(parts),
  ]
    .filter((chunk) => chunk !== '')
    .join('\n\n');
  return { sql: `${sql}\n`, warnings };
}

async function loadScopes(
  cwd: string,
  config: PermDockConfig,
): Promise<readonly Scope[]> {
  if (config.policy === undefined) {
    throw new Error(
      'PermDock CLI: supabase hook generate needs policy in permdock.config.ts',
    );
  }
  const policy = asPolicy(
    pickNamed(await loadModule(resolve(cwd, config.policy)), ['policy']),
  );
  return scopeList(policy.scopes);
}

export async function runSupabase(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly rest: readonly string[];
  readonly out?: string;
  readonly check: boolean;
  readonly activeFrom?: string;
  readonly budget?: string;
  readonly schema?: string;
  readonly io: CliIo;
}): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  const [area, action] = input.rest;
  if (area !== 'hook' || action !== 'generate') {
    return { code: 2, output: SUPABASE_HELP };
  }
  const scopes = await loadScopes(input.cwd, input.config);
  const { sql, warnings } = supabaseHookSql(
    scopes,
    input.config,
    Object.fromEntries(
      Object.entries({
        activeFrom: input.activeFrom,
        budget: input.budget,
        schema: input.schema,
      }).filter(([, value]) => value !== undefined),
    ),
  );
  const outRel =
    input.out ??
    input.config.supabase?.hook?.out ??
    'supabase/permdock-hook.sql';
  const outPath = resolve(input.cwd, outRel);
  const hook = input.config.supabase?.hook;
  const toml = configToml(
    input.schema ?? hook?.schema ?? input.config.rls?.schema ?? 'public',
    hook?.jwtExpiry ?? 900,
  );
  if (input.check) {
    if (!existsSync(outPath)) {
      return { code: 1, output: `supabase hook drift: missing ${outRel}` };
    }
    return readFileSync(outPath, 'utf8') === sql
      ? { code: 0, output: 'supabase hook up to date' }
      : { code: 1, output: 'supabase hook drift' };
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, sql);
  return {
    code: 0,
    output: [
      `wrote ${outRel}`,
      'add to supabase/config.toml:',
      toml,
      ...warnings,
    ].join('\n'),
  };
}
