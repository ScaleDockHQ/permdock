import type { CompiledPolicy } from './rls-compile.ts';
import type { RolePermission } from './rls-helpers.ts';

import { callsHelper, HELPER_TABLES, helperCallKeys } from './helper-calls.ts';
import { requirePeer } from './peer.ts';

const ROLES = ['anon', 'authenticated'] as const;
const PRIVILEGES = ['select', 'insert', 'update', 'delete'] as const;

type Privilege = (typeof PRIVILEGES)[number];

/** What `rls generate` would write, reduced to what the catalogs can confirm. */
export type ExpectedRls = {
  readonly policies: readonly {
    readonly table: string;
    readonly name: string;
    readonly command: string;
    readonly permissive: boolean;
    readonly roles: readonly string[];
  }[];
  readonly tables: readonly string[];
  /** Per table and role, the privileges `grant` leaves after `revoke all`. */
  readonly grants: Readonly<
    Record<string, Readonly<Record<string, readonly Privilege[]>>>
  >;
  /** `security definer` functions, as `schema.name`. */
  readonly helpers: readonly string[];
};

/** The same facts, read from `pg_policies`, `pg_class`, the table grants and `pg_proc`. */
export type ActualRls = {
  readonly policies: readonly {
    readonly table: string;
    readonly name: string;
    readonly command: string;
    readonly permissive: boolean;
    readonly roles: readonly string[];
  }[];
  readonly rlsEnabled: Readonly<Record<string, boolean>>;
  readonly grants: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
  readonly helpers: Readonly<
    Record<
      string,
      {
        readonly securityDefiner: boolean;
        readonly emptySearchPath: boolean;
      }
    >
  >;
};

/** `posts` and `"app"."posts"` as `public.posts` and `app.posts`. */
export function qualified(table: string): string {
  const parts = table.split('.').map((part) => part.replaceAll('"', ''));
  return parts.length === 1 ? `public.${parts[0] ?? ''}` : parts.join('.');
}

const FUNCTION_HEADER =
  /create or replace function ("?)([A-Za-z_][\w$]*)\1\.("?)([A-Za-z_][\w$]*)\3\s*\(([\s\S]*?)\nas \$/gu;

function helpersOf(sql: string): readonly string[] {
  const found = new Set<string>();
  for (const match of sql.matchAll(FUNCTION_HEADER)) {
    const [header = '', , schema = '', , name = ''] = match;
    if (/\bsecurity definer\b/u.test(header)) {
      found.add(`${schema}.${name}`);
    }
  }
  return [...found];
}

export function expectedRls(
  policies: readonly CompiledPolicy[],
  sql: string,
): ExpectedRls {
  const tables = [...new Set(policies.map((item) => qualified(item.table)))];
  const grants: Record<string, Record<string, Privilege[]>> = {};
  for (const table of tables) {
    const byRole: Record<string, Privilege[]> = {};
    for (const role of ROLES) {
      const commands = new Set(
        policies
          .filter(
            (item) =>
              qualified(item.table) === table &&
              item.effect === 'allow' &&
              item.roles.includes(role),
          )
          .map((item) => item.command),
      );
      byRole[role] = PRIVILEGES.filter((privilege) => commands.has(privilege));
    }
    grants[table] = byRole;
  }
  return {
    policies: policies.map((item) => ({
      table: qualified(item.table),
      name: item.name,
      command: item.command,
      permissive: item.effect === 'allow',
      roles: item.roles.toSorted(),
    })),
    tables,
    grants,
    helpers: helpersOf(sql),
  };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  const a = left.toSorted();
  const b = right.toSorted();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** One line per difference; policy expressions are not compared, since Postgres rewrites their text. */
export function diffRls(
  expected: ExpectedRls,
  actual: ActualRls,
  options: { readonly columnGrants?: boolean } = {},
): readonly string[] {
  const out: string[] = [];
  const found = new Map(
    actual.policies.map((item) => [`${item.table}\u0000${item.name}`, item]),
  );
  for (const want of expected.policies) {
    const have = found.get(`${want.table}\u0000${want.name}`);
    if (have === undefined) {
      out.push(`${want.table}: policy ${want.name} is missing`);
      continue;
    }
    if (have.command !== want.command) {
      out.push(
        `${want.table}: policy ${want.name} is for ${have.command}, expected ${want.command}`,
      );
    }
    if (have.permissive !== want.permissive) {
      out.push(
        `${want.table}: policy ${want.name} is ${have.permissive ? 'permissive' : 'restrictive'}, expected ${want.permissive ? 'permissive' : 'restrictive'}`,
      );
    }
    if (!sameList(have.roles, want.roles)) {
      out.push(
        `${want.table}: policy ${want.name} applies to ${have.roles.join(', ')}, expected ${want.roles.join(', ')}`,
      );
    }
  }
  const wanted = new Set(
    expected.policies.map((item) => `${item.table}\u0000${item.name}`),
  );
  for (const have of actual.policies) {
    if (
      expected.tables.includes(have.table) &&
      !wanted.has(`${have.table}\u0000${have.name}`)
    ) {
      out.push(
        `${have.table}: policy ${have.name} is not generated (${have.permissive ? 'permissive' : 'restrictive'} ${have.command}); a permissive one widens access`,
      );
    }
  }
  for (const table of expected.tables) {
    if (actual.rlsEnabled[table] !== true) {
      out.push(
        actual.rlsEnabled[table] === undefined
          ? `${table}: table is missing`
          : `${table}: row level security is disabled`,
      );
      continue;
    }
    for (const role of ROLES) {
      const want = expected.grants[table]?.[role] ?? [];
      const have = actual.grants[table]?.[role] ?? [];
      for (const privilege of want) {
        if (
          !have.includes(privilege) &&
          !(privilege === 'select' && options.columnGrants === true)
        ) {
          out.push(
            `${table}: ${role} lacks ${privilege}, so the policy answers 42501 instead of filtering`,
          );
        }
      }
      for (const privilege of have) {
        // SAFETY: widening the privilege union to string only lets includes() accept a catalog value.
        if (!(want as readonly string[]).includes(privilege)) {
          out.push(
            `${table}: ${role} holds ${privilege}, which no generated policy allows`,
          );
        }
      }
    }
  }
  for (const helper of expected.helpers) {
    const have = actual.helpers[helper];
    if (have === undefined) {
      out.push(`${helper}: helper is missing`);
      continue;
    }
    if (!have.securityDefiner) {
      out.push(`${helper}: helper is not security definer`);
    }
    if (!have.emptySearchPath) {
      out.push(`${helper}: helper does not set search_path = ''`);
    }
  }
  return out;
}

const POLICIES_SQL = `select schemaname || '.' || tablename as target, policyname, cmd, permissive, roles::text[] as roles
from pg_policies
where schemaname || '.' || tablename = any($1::text[])`;

const TABLES_SQL = `select n.nspname || '.' || c.relname as target, c.relrowsecurity as enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and n.nspname || '.' || c.relname = any($1::text[])`;

const GRANTS_SQL = `select table_schema || '.' || table_name as target, grantee, lower(privilege_type) as privilege
from information_schema.role_table_grants
where grantee in ('anon', 'authenticated')
  and lower(privilege_type) in ('select', 'insert', 'update', 'delete')
  and table_schema || '.' || table_name = any($1::text[])`;

const HELPERS_SQL = `select n.nspname || '.' || p.proname as target, p.prosecdef as definer,
  coalesce(array_to_string(p.proconfig, ','), '') as config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname || '.' || p.proname = any($1::text[])`;

function commandOf(cmd: unknown): string {
  const text = String(cmd ?? '').toLowerCase();
  return text === '*' ? 'all' : text;
}

/** Reads the catalogs for the tables and helpers `expected` names (postgres-meta's queries, trimmed). */
export async function introspectRls(
  db: string,
  expected: ExpectedRls,
): Promise<ActualRls> {
  const pg = await requirePeer(
    () => import('pg'),
    'pg',
    'permdock rls verify --introspect',
  );
  const client = new pg.Client({ connectionString: db });
  try {
    await client.connect();
  } catch (cause) {
    throw new Error('PermDock CLI: rls verify --introspect could not connect', {
      cause,
    });
  }
  try {
    const tables = [...expected.tables];
    const policies = await client.query(POLICIES_SQL, [tables]);
    const enabled = await client.query(TABLES_SQL, [tables]);
    const grants = await client.query(GRANTS_SQL, [tables]);
    const helpers = await client.query(HELPERS_SQL, [[...expected.helpers]]);
    const byTable: Record<string, Record<string, string[]>> = {};
    // SAFETY: pg rows are objects keyed by the SELECT's columns; every field is read through String().
    for (const row of grants.rows as Record<string, unknown>[]) {
      const table = String(row['target']);
      const role = String(row['grantee']);
      const entry = (byTable[table] ??= {});
      (entry[role] ??= []).push(String(row['privilege']));
    }
    // SAFETY: pg rows are objects keyed by each SELECT's columns; fields are narrowed as they are read.
    return {
      policies: (policies.rows as Record<string, unknown>[]).map((row) => ({
        table: String(row['target']),
        name: String(row['policyname']),
        command: commandOf(row['cmd']),
        permissive: String(row['permissive']).toUpperCase() === 'PERMISSIVE',
        roles: Array.isArray(row['roles']) ? row['roles'].map(String) : [],
      })),
      rlsEnabled: Object.fromEntries(
        (enabled.rows as Record<string, unknown>[]).map((row) => [
          String(row['target']),
          row['enabled'] === true,
        ]),
      ),
      grants: byTable,
      helpers: Object.fromEntries(
        (helpers.rows as Record<string, unknown>[]).map((row) => [
          String(row['target']),
          {
            securityDefiner: row['definer'] === true,
            emptySearchPath: String(row['config'])
              .split(',')
              .some(
                (item) =>
                  item === 'search_path=""' || item === "search_path=''",
              ),
          },
        ]),
      ),
    };
  } finally {
    await client.end();
  }
}

/** A helpers-only setup: the seeds `generate` would write and the keys hand-written policies may pass. */
export type ExpectedMixed = {
  readonly schema: string;
  readonly seeds: readonly RolePermission[];
  readonly permissions: readonly string[];
  readonly rowConditions: readonly string[];
};

/** Every policy and RLS table outside the system schemas, and the seeded rows. */
export type ActualMixed = {
  readonly seeds: readonly RolePermission[];
  readonly policies: readonly {
    readonly table: string;
    readonly name: string;
    readonly expression: string;
  }[];
  readonly rlsTables: readonly string[];
};

const SYSTEM_SCHEMAS = [
  'pg_catalog',
  'information_schema',
  'pg_toast',
  'auth',
  'storage',
  'realtime',
  'extensions',
  'graphql',
  'graphql_public',
  'vault',
  'pgsodium',
  'pgsodium_masks',
  'net',
  'cron',
  'supabase_functions',
  'supabase_migrations',
] as const;

function inScope(table: string): boolean {
  const schema = table.split('.')[0] ?? '';
  return (
    HELPER_TABLES.some((item) => item === table) ||
    !(
      SYSTEM_SCHEMAS.some((item) => item === schema) || schema.startsWith('pg_')
    )
  );
}

function seedLine(row: RolePermission): string {
  return `${row.role} ${row.effect} ${row.grantKey} on ${row.scope}`;
}

/** Drift is an error; `info` names RLS tables whose policies call no PermDock helper. */
export function diffMixed(
  expected: ExpectedMixed,
  actual: ActualMixed,
): { readonly drift: readonly string[]; readonly info: readonly string[] } {
  const drift: string[] = [];
  const want = new Set(expected.seeds.map(seedLine));
  const have = new Set(actual.seeds.map(seedLine));
  for (const line of want) {
    if (!have.has(line)) {
      drift.push(`${expected.schema}.role_permissions: missing ${line}`);
    }
  }
  for (const line of have) {
    if (!want.has(line)) {
      drift.push(`${expected.schema}.role_permissions: unexpected ${line}`);
    }
  }
  const permissions = new Set(expected.permissions);
  const conditioned = new Set(expected.rowConditions);
  const covered = new Set<string>();
  for (const policy of actual.policies) {
    if (callsHelper(policy.expression)) {
      covered.add(policy.table);
    }
    for (const key of helperCallKeys(policy.expression)) {
      if (!permissions.has(key)) {
        drift.push(
          `${policy.table}: policy ${policy.name} passes ${key}, which the policy does not declare, so it always denies`,
        );
      } else if (conditioned.has(key)) {
        drift.push(
          `${policy.table}: policy ${policy.name} passes ${key}, whose grants carry row conditions the helpers do not check: the policy grants more than the application does`,
        );
      }
    }
  }
  const info = actual.rlsTables
    .filter((table) => !covered.has(table))
    .map((table) => `${table}: no policy calls a PermDock helper`);
  return { drift, info };
}

const ALL_POLICIES_SQL = `select schemaname || '.' || tablename as target, policyname,
  coalesce(qual, '') || ' ' || coalesce(with_check, '') as expression
from pg_policies`;

const RLS_TABLES_SQL = `select n.nspname || '.' || c.relname as target
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and c.relrowsecurity`;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function rows(result: {
  readonly rows: readonly unknown[];
}): readonly Record<string, unknown>[] {
  // SAFETY: pg rows are objects keyed by each SELECT's columns; every field is read through String().
  return result.rows as readonly Record<string, unknown>[];
}

/** Reads `role_permissions`, `pg_policies` and the RLS-enabled tables for {@link diffMixed}. */
export async function introspectMixed(
  db: string,
  schema: string,
): Promise<ActualMixed> {
  const pg = await requirePeer(
    () => import('pg'),
    'pg',
    'permdock rls verify --introspect',
  );
  const client = new pg.Client({ connectionString: db });
  try {
    await client.connect();
  } catch (cause) {
    throw new Error('PermDock CLI: rls verify --introspect could not connect', {
      cause,
    });
  }
  try {
    const seeds = await client.query(
      `select role, permission, grant_key, scope, effect from ${quoteIdent(schema)}.role_permissions`,
    );
    const policies = await client.query(ALL_POLICIES_SQL);
    const tables = await client.query(RLS_TABLES_SQL);
    return {
      seeds: rows(seeds).map((row) => ({
        role: String(row['role']),
        permission: String(row['permission']),
        grantKey: String(row['grant_key']),
        scope: String(row['scope']),
        effect: String(row['effect']) === 'deny' ? 'deny' : 'allow',
      })),
      policies: rows(policies)
        .map((row) => ({
          table: String(row['target']),
          name: String(row['policyname']),
          expression: String(row['expression']),
        }))
        .filter((row) => inScope(row.table)),
      rlsTables: rows(tables)
        .map((row) => String(row['target']))
        .filter(inScope)
        .toSorted(),
    };
  } finally {
    await client.end();
  }
}
