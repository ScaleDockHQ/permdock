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
  supabaseTenantClaim,
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

const CLAIM_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const USER_EDITABLE = /^(raw_)?user_meta(_)?data$/iu;

export type AttrsPlan = {
  readonly table?: string;
  readonly id: string;
  /** Columns of `table`, each also the claim key. */
  readonly columns: readonly string[];
  /** `app_metadata` keys, each also the claim key. */
  readonly meta: readonly string[];
  readonly errors: readonly string[];
};

/**
 * Splits `supabase.hook.attrs` into table columns and `app_metadata` keys and
 * lists what cannot be compiled: `user_metadata` (the user can edit it), a
 * direct `auth.users` column, an unsafe or prototype key, a duplicate key,
 * or a table column without a table.
 */
export function attrsPlan(
  attrs: NonNullable<SupabaseHookConfig['attrs']>,
): AttrsPlan {
  const errors: string[] = [];
  const columns: string[] = [];
  const meta: string[] = [];
  const seen = new Set<string>();
  const tableName = attrs.table?.replaceAll('"', '').toLowerCase();
  if (tableName === 'auth.users') {
    errors.push(
      'supabase.hook.attrs.table cannot be auth.users: list app_metadata.<key> entries instead',
    );
  }
  for (const entry of attrs.columns) {
    const [head = '', ...rest] = entry.split('.');
    const isMeta = head === 'app_metadata' || head === 'raw_app_meta_data';
    const key = isMeta ? rest.join('.') : entry;
    if (
      USER_EDITABLE.test(head) ||
      USER_EDITABLE.test(key) ||
      /user_?meta/iu.test(entry)
    ) {
      errors.push(
        `supabase.hook.attrs lists ${entry}: user_metadata is user-editable and never becomes a claim`,
      );
      continue;
    }
    if (!CLAIM_KEY.test(key) || PROTOTYPE_KEYS.has(key)) {
      errors.push(
        `supabase.hook.attrs lists ${entry}: a key must match ${CLAIM_KEY.source} and not be a prototype key`,
      );
      continue;
    }
    if (seen.has(key)) {
      errors.push(`supabase.hook.attrs names the key ${key} twice`);
      continue;
    }
    seen.add(key);
    if (isMeta) {
      meta.push(key);
    } else {
      columns.push(key);
    }
  }
  if (columns.length > 0 && attrs.table === undefined) {
    errors.push(
      `supabase.hook.attrs lists ${columns.join(', ')} without a table`,
    );
  }
  return {
    ...(attrs.table === undefined ? {} : { table: attrs.table }),
    id: attrs.id ?? 'id',
    columns,
    meta,
    errors,
  };
}

/**
 * Claim names `supabase.hook.claims` cannot write: the ones this hook owns
 * (plus the tenant claim) and the ones Supabase Auth issues.
 */
export const RESERVED_CLAIMS: readonly string[] = [
  'roles',
  'user_role',
  'memberships',
  'memberships_truncated',
  'attrs',
  'authz_ver',
  'sub',
  'aud',
  'role',
  'exp',
  'iat',
  'iss',
  'aal',
  'amr',
  'session_id',
  'is_anonymous',
  'email',
  'phone',
  'app_metadata',
  'user_metadata',
];

const CLAIM_FUNCTION = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/u;

export type ExtraClaim = {
  readonly claim: string;
  /** `<schema>.<function>(uuid) returns jsonb`. */
  readonly fn: string;
};

/**
 * Checks `supabase.hook.claims`: each name is a safe claim key outside
 * {@link RESERVED_CLAIMS} and the tenant claim, each function is
 * schema-qualified (the hook runs with an empty `search_path`).
 */
export function extraClaimsPlan(
  claims: SupabaseHookConfig['claims'],
  tenantClaim: string,
): {
  readonly claims: readonly ExtraClaim[];
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  const planned: ExtraClaim[] = [];
  for (const [claim, fn] of Object.entries(claims ?? {})) {
    if (!CLAIM_KEY.test(claim) || PROTOTYPE_KEYS.has(claim)) {
      errors.push(
        `supabase.hook.claims names ${claim}: a claim must match ${CLAIM_KEY.source} and not be a prototype key`,
      );
      continue;
    }
    if (RESERVED_CLAIMS.includes(claim) || claim === tenantClaim) {
      errors.push(
        `supabase.hook.claims names ${claim}, which PermDock or Supabase Auth writes`,
      );
      continue;
    }
    if (typeof fn !== 'string' || !CLAIM_FUNCTION.test(fn)) {
      errors.push(
        `supabase.hook.claims.${claim} must be a schema-qualified function name such as better_supabase.feature_claims`,
      );
      continue;
    }
    planned.push({ claim, fn });
  }
  return { claims: planned, errors };
}

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
  readonly attrs: AttrsPlan | undefined;
  readonly extra: readonly ExtraClaim[];
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
    'expiresAt', s.expires_at, 'grantedBy', s.granted_by, 'reason', s.reason,
    'member', case when s.member_group is not null then jsonb_build_object('group', s.member_group) end,
    'managedBy', s.managed_by, 'entitlements', s.seats
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
  const plan = parts.attrs;
  const fromTable =
    plan === undefined || plan.columns.length === 0 || plan.table === undefined
      ? ''
      : `
  select jsonb_strip_nulls(jsonb_build_object(${plan.columns
    .map(
      (column) => `${quoteLiteral(column)}, to_jsonb(p.${quoteIdent(column)})`,
    )
    .join(', ')}))
    into attrs
    from ${table(plan.table)} p
    where p.${quoteIdent(plan.id)}::text = uid;`;
  const fromMeta =
    plan === undefined || plan.meta.length === 0
      ? ''
      : `
  attrs := coalesce(attrs, '{}'::jsonb) || coalesce((
    select jsonb_strip_nulls(jsonb_build_object(${plan.meta
      .map(
        (key) =>
          `${quoteLiteral(key)}, u.raw_app_meta_data -> ${quoteLiteral(key)}`,
      )
      .join(', ')}))
    from auth.users u
    where u.id = uid::uuid
  ), '{}'::jsonb);`;
  const attrs =
    plan === undefined
      ? ''
      : `${fromTable}${fromMeta}
  if attrs is not null and attrs <> '{}'::jsonb then
    used := octet_length(attrs::text);
    if used > budget then
      truncated := true;
      used := 0;
    else
      claims := jsonb_set(claims, '{attrs}', attrs);
    end if;
  end if;`;
  const versionTable = `${schema}.${quoteIdent(AUTHZ_VERSION_TABLE)}`;
  const version = parts.version
    ? `
  select v.version into ver from ${versionTable} v where v.user_id = uid;
  claims := jsonb_set(claims, '{authz_ver}', to_jsonb(coalesce(ver, 0)));`
    : '';
  const dropExtra = parts.extra
    .map((entry) => ` - ${quoteLiteral(entry.claim)}`)
    .join('');
  const extra = parts.extra
    .map(
      (entry) => `
  extra := ${quoteTable(entry.fn)}(uid::uuid);
  if extra is not null then
    claims := jsonb_set(claims, ${quoteLiteral(`{${entry.claim}}`)}, extra);
  end if;`,
    )
    .join('');
  const suspended =
    parts.users === undefined
      ? ''
      : `
  if not ${activeRowSql(parts.users, 'uid::uuid')} then
    claims := claims - 'memberships_truncated' - 'attrs' - ${quoteLiteral(parts.tenantClaim)}${dropExtra};
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
  used integer := 0;
  item record;${plan === undefined ? '' : '\n  attrs jsonb;'}${parts.extra.length === 0 ? '' : '\n  extra jsonb;'}${parts.version ? '\n  ver bigint;' : ''}
begin${suspended}
  claims := claims - 'attrs'${dropExtra};
${roles}
  claims := jsonb_set(claims, '{roles}', held);
  if jsonb_array_length(held) = 1 then
    claims := jsonb_set(claims, '{user_role}', held -> 0);
  elsif jsonb_array_length(held) > 1 then
    claims := jsonb_set(claims, '{user_role}', held);
  end if;
  active := ${parts.active};${attrs}
  for item in
    select x.entry, x.tenant is not distinct from active as current
    from (
${entriesSql(parts).replaceAll(/^/gmu, '      ')}
    ) x
    order by (x.tenant is not distinct from active) desc, x.ord, x.entry ->> 'scope', x.entry ->> 'id', x.entry::text
  loop
    if octet_length((kept || jsonb_build_array(item.entry))::text) + used > budget then
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
  end if;${extra}${version}
  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage on schema ${schema} to supabase_auth_admin;
grant execute on function ${fn}(jsonb) to supabase_auth_admin;
revoke execute on function ${fn}(jsonb) from authenticated, anon, public;${extraGrantsSql(parts.extra)}`;
}

function extraGrantsSql(extra: readonly ExtraClaim[]): string {
  const schemas = [...new Set(extra.map((entry) => entry.fn.split('.')[0]))];
  return [
    ...schemas.map(
      (name) =>
        `\ngrant usage on schema ${quoteIdent(name ?? '')} to supabase_auth_admin;`,
    ),
    ...extra.map(
      (entry) =>
        `\ngrant execute on function ${quoteTable(entry.fn)}(uuid) to supabase_auth_admin;`,
    ),
  ].join('');
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
  if (parts.attrs?.table !== undefined && parts.attrs.columns.length > 0) {
    reads.set(parts.attrs.table, reads.get(parts.attrs.table) ?? 'attrs');
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

/**
 * Fails the migration when a client role can write an `attrs` column: a
 * claim the user can set is not a server-owned attribute.
 */
function attrsGuardSql(plan: AttrsPlan | undefined): string {
  if (plan?.table === undefined || plan.columns.length === 0) {
    return '';
  }
  const target = quoteLiteral(table(plan.table));
  const columns = plan.columns
    .map((column) => `(${quoteLiteral(column)})`)
    .join(', ');
  return `-- attrs must be server-owned: refuse columns anon or authenticated can insert or update
do $$
begin
  if exists (
    select 1
    from (values ${columns}) c(name)
    cross join (values ('anon'), ('authenticated')) r(role)
    where has_column_privilege(r.role, ${target}, c.name, 'INSERT')
       or has_column_privilege(r.role, ${target}, c.name, 'UPDATE')
  ) then
    raise exception 'PermDock: an attrs column of % is writable by anon or authenticated; revoke insert and update on it before it becomes a claim', ${target}
      using errcode = '42501';
  end if;
end
$$;`;
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
  const tenantClaim = config.rls?.tenantClaim ?? supabaseTenantClaim;
  const extraPlan = extraClaimsPlan(hook.claims, tenantClaim);
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
    tenantClaim,
    users: suspension?.users,
    hook,
    active: activeFromSql(overrides.activeFrom ?? hook.activeFrom, root),
    attrs: hook.attrs === undefined ? undefined : attrsPlan(hook.attrs),
    extra: extraPlan.claims,
  };
  if (parts.attrs !== undefined && parts.attrs.errors.length > 0) {
    throw new Error(`PermDock CLI: ${parts.attrs.errors.join('; ')}`);
  }
  if (extraPlan.errors.length > 0) {
    throw new Error(`PermDock CLI: ${extraPlan.errors.join('; ')}`);
  }
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
-- claims: user_role, roles, memberships (active ${root} first, at most ${String(parts.budget)} bytes; memberships_truncated when cut), ${parts.tenantClaim}${parts.attrs === undefined ? '' : ', attrs (counted in the budget)'}${parts.version ? ', authz_ver' : ''}${parts.extra.map((entry) => `, ${entry.claim} (${entry.fn}, outside the budget)`).join('')}
-- supabase/config.toml:
${toml}`,
    attrsGuardSql(parts.attrs),
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
