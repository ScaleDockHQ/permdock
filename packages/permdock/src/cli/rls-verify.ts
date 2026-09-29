import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  CustomRole,
  PermDock,
  Permission,
  Policy,
  Subject,
} from '../index.ts';
import type { CliIo, PermDockConfig, RlsDialect } from './types.ts';

import {
  createPermDock,
  customRoleClaim,
  findPermission,
  hasConditionOp,
  memoryRoleSource,
} from '../index.ts';
import { asPolicy, loadModule, pickNamed } from './load.ts';
import { requirePeer } from './peer.ts';

export type VerifyOutcome = {
  readonly code: 0 | 1 | 2;
  readonly output: string;
};

export type RlsFixture = {
  readonly subject: {
    readonly id: string;
    readonly roles?: readonly string[];
    readonly tenant?: string;
    readonly memberships?: readonly {
      readonly tenant?: string;
      readonly team?: string;
      readonly roles: readonly string[];
    }[];
  };
  readonly row: unknown;
  readonly newRow?: unknown;
  readonly action: string;
  readonly expected?: 'granted' | 'denied';
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asFixtures(value: unknown): readonly RlsFixture[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.fixtures)
      ? value.fixtures
      : undefined;
  if (list === undefined) {
    throw new Error('PermDock CLI: fixtures must be an array or { fixtures }');
  }
  return list.map((item, index) => {
    if (!isRecord(item) || !isRecord(item.subject) || item.row === undefined) {
      throw new Error(`PermDock CLI: fixture ${index} needs subject and row`);
    }
    if (typeof item.action !== 'string') {
      throw new TypeError(`PermDock CLI: fixture ${index} needs action`);
    }
    if (typeof item.subject.id !== 'string') {
      throw new TypeError(`PermDock CLI: fixture ${index} subject needs id`);
    }
    const memberships = item.subject.memberships;
    if (memberships !== undefined && !Array.isArray(memberships)) {
      throw new Error(
        `PermDock CLI: fixture ${index} subject.memberships must be an array`,
      );
    }
    const tenant = item.subject.tenant;
    if (tenant !== undefined && typeof tenant !== 'string') {
      throw new Error(
        `PermDock CLI: fixture ${index} subject.tenant must be a string`,
      );
    }
    return item as RlsFixture;
  });
}

type FixtureFile = {
  readonly fixtures: readonly RlsFixture[];
  /** Tenant-defined roles the fixtures' memberships may hold. */
  readonly customRoles: readonly CustomRole[];
};

function asCustomRoles(value: unknown): readonly CustomRole[] {
  if (!isRecord(value) || value.customRoles === undefined) {
    return [];
  }
  if (!Array.isArray(value.customRoles)) {
    throw new TypeError('PermDock CLI: fixtures customRoles must be an array');
  }
  return value.customRoles as readonly CustomRole[];
}

async function loadFixtures(cwd: string, path: string): Promise<FixtureFile> {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) {
    throw new Error(`PermDock CLI: fixtures not found: ${path}`);
  }
  if (abs.endsWith('.json')) {
    const parsed: unknown = JSON.parse(readFileSync(abs, 'utf8'));
    return { fixtures: asFixtures(parsed), customRoles: asCustomRoles(parsed) };
  }
  const mod = await loadModule(abs);
  return {
    fixtures: asFixtures(pickNamed(mod, ['fixtures', 'default'])),
    customRoles: asCustomRoles(mod),
  };
}

/** Each membership's custom roles as the compact `grants` claim RLS reads in `jwt` mode. */
function withCustomGrants(
  memberships: RlsFixture['subject']['memberships'] & object,
  customRoles: readonly CustomRole[],
): readonly Record<string, unknown>[] {
  return memberships.map((membership) => {
    const held = customRoles.filter(
      (role) =>
        role.tenant === membership.tenant &&
        role.team === membership.team &&
        membership.roles.includes(role.name),
    );
    return held.length === 0
      ? membership
      : { ...membership, grants: customRoleClaim(held) };
  });
}

function canFixture(
  dock: PermDock,
  permission: Permission,
  row: unknown,
): boolean {
  if (permission.kind === 'collection') {
    return dock.can(
      permission as Permission<string, unknown, 'collection'>,
      row,
    );
  }
  return dock.can(permission as Permission<string, unknown, 'instance'>, row);
}

function toSubject(fixture: RlsFixture['subject']): Subject {
  return {
    principal: {
      id: fixture.id,
      roles: fixture.roles ?? [],
      ...(fixture.tenant === undefined ? {} : { tenant: fixture.tenant }),
      memberships: fixture.memberships ?? [],
    },
    context: {},
  };
}

function grantKind(
  policy: Policy,
  key: string,
): 'opaque' | 'sqlFunction' | 'portable' {
  const grants = policy.grants.filter((grant) => grant.permission.key === key);
  if (
    grants.some(
      (grant) =>
        hasConditionOp(grant.where, 'opaque') ||
        hasConditionOp(grant.check, 'opaque'),
    )
  ) {
    return 'opaque';
  }
  if (
    grants.some(
      (grant) =>
        hasConditionOp(grant.where, 'sqlFunction') ||
        hasConditionOp(grant.check, 'sqlFunction'),
    )
  ) {
    return 'sqlFunction';
  }
  return 'portable';
}

function quoteIdent(name: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`PermDock CLI: unsafe SQL identifier '${name}'`);
  }
  return `"${name}"`;
}

type Statement = { readonly sql: string; readonly values: readonly unknown[] };

function columnsOf(row: unknown): readonly (readonly [string, unknown])[] {
  return isRecord(row)
    ? Object.entries(row).filter(
        ([, value]) => value !== undefined && typeof value !== 'object',
      )
    : [];
}

/** The statement a fixture runs: `create` inserts the whole row, `update` writes `newRow` when given. */
function statementFor(
  fixture: RlsFixture,
  action: string,
  table: string,
): Statement {
  const quoted = quoteIdent(table);
  const id = quoteIdent('id');
  const key = rowId(fixture.row);
  switch (action) {
    case 'read':
    case 'list':
    case 'get':
      return { sql: `select * from ${quoted} where ${id} = $1`, values: [key] };
    case 'update': {
      const next = columnsOf(fixture.newRow).filter(([name]) => name !== 'id');
      const sets =
        next.length === 0
          ? `${id} = ${id}`
          : next
              .map(([name], index) => `${quoteIdent(name)} = $${index + 2}`)
              .join(', ');
      return {
        sql: `update ${quoted} set ${sets} where ${id} = $1 returning *`,
        values: [key, ...next.map(([, value]) => value)],
      };
    }
    case 'create': {
      const cols = columnsOf(fixture.row);
      if (cols.length === 0) {
        return {
          sql: `insert into ${quoted} (${id}) values ($1) returning *`,
          values: [key],
        };
      }
      return {
        sql: `insert into ${quoted} (${cols.map(([name]) => quoteIdent(name)).join(', ')}) values (${cols.map((_, index) => `$${index + 1}`).join(', ')}) returning *`,
        values: cols.map(([, value]) => value),
      };
    }
    case 'delete':
      return {
        sql: `delete from ${quoted} where ${id} = $1 returning *`,
        values: [key],
      };
    default:
      return { sql: `select * from ${quoted} where ${id} = $1`, values: [key] };
  }
}

function rowId(row: unknown): unknown {
  if (isRecord(row) && 'id' in row) {
    return row.id;
  }
  return undefined;
}

function emitPgtap(
  fixtures: readonly RlsFixture[],
  customRoles: readonly CustomRole[],
): string {
  const lines = [
    'begin;',
    `select plan(${fixtures.length});`,
    '-- fixtures carry memberships and tenant for the exists join',
  ];
  for (const [index, fixture] of fixtures.entries()) {
    const claims = JSON.stringify({
      sub: fixture.subject.id,
      role: 'authenticated',
      tenant_id: fixture.subject.tenant ?? null,
      memberships: withCustomGrants(
        fixture.subject.memberships ?? [],
        customRoles,
      ),
    });
    lines.push(
      `-- ${fixture.action}`,
      `select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true);`,
      `select set_config('request.jwt.claim.sub', ${JSON.stringify(fixture.subject.id)}, true);`,
      `select ok(true, 'fixture ${index} ${fixture.action}');`,
    );
  }
  lines.push('select * from finish();', 'rollback;');
  return `${lines.join('\n')}\n`;
}

function loadPg(): Promise<typeof import('pg')> {
  return requirePeer(() => import('pg'), 'pg', 'permdock rls verify --db');
}

type QueryFn = (
  sql: string,
  values?: readonly unknown[],
) => Promise<{
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount?: number;
  readonly code?: string;
}>;

/** Writes the custom roles into the `database`-mode tables; the fixture transaction rolls them back. */
async function seedCustomRoles(
  query: QueryFn,
  schema: string,
  customRoles: readonly CustomRole[],
): Promise<void> {
  const table = (name: string): string =>
    `${quoteIdent(schema)}.${quoteIdent(name)}`;
  const write = async (
    sql: string,
    values: readonly unknown[],
  ): Promise<void> => {
    const result = await query(sql, values);
    if (result.code !== undefined) {
      throw new Error(
        `PermDock CLI: rls verify --db could not seed custom roles (${result.code}); connect as a role that owns the custom_role_* tables`,
      );
    }
  };
  for (const role of customRoles) {
    for (const grant of role.grants ?? []) {
      await write(
        `insert into ${table('custom_role_permissions')} (tenant_id, team_id, role, permission, effect) values ($1, $2, $3, $4, $5)`,
        [
          role.tenant,
          role.team ?? null,
          role.name,
          grant.permission,
          grant.effect ?? 'allow',
        ],
      );
    }
    for (const name of role.includes ?? []) {
      await write(
        `insert into ${table('custom_role_includes')} (tenant_id, team_id, role, include_role) values ($1, $2, $3, $4)`,
        [role.tenant, role.team ?? null, role.name, name],
      );
    }
  }
}

async function bindSubject(
  query: QueryFn,
  fixture: RlsFixture,
  dialect: RlsDialect,
  gucPrefix: string,
  tenantClaim: string,
  roleClaim: string,
  customRoles: readonly CustomRole[],
): Promise<void> {
  await query('set local role "authenticated"');
  const roles = fixture.subject.roles ?? [];
  const memberships = withCustomGrants(
    fixture.subject.memberships ?? [],
    customRoles,
  );
  if (dialect === 'guc') {
    const settings: [string, string][] = [
      [`${gucPrefix}.user_id`, fixture.subject.id],
      [`${gucPrefix}.${roleClaim}`, roles.join(',')],
      [`${gucPrefix}.memberships`, JSON.stringify(memberships)],
    ];
    if (fixture.subject.tenant !== undefined) {
      settings.push([`${gucPrefix}.${tenantClaim}`, fixture.subject.tenant]);
    }
    for (const [name, value] of settings) {
      await query('select set_config($1, $2, true)', [name, value]);
    }
    return;
  }
  const claims = {
    sub: fixture.subject.id,
    role: 'authenticated',
    [roleClaim]: roles.length === 1 ? roles[0] : roles,
    [tenantClaim]: fixture.subject.tenant,
    memberships,
  };
  await query('select set_config($1, $2, true)', [
    'request.jwt.claims',
    JSON.stringify(claims),
  ]);
  await query('select set_config($1, $2, true)', [
    'request.jwt.claim.sub',
    fixture.subject.id,
  ]);
}

async function verifyAgainstDatabase(input: {
  readonly db: string;
  readonly policy: Policy;
  readonly fixtures: readonly RlsFixture[];
  readonly customRoles: readonly CustomRole[];
  readonly config: PermDockConfig;
  readonly inProcess: readonly {
    readonly action: string;
    readonly granted: boolean;
    readonly kind: 'opaque' | 'sqlFunction' | 'portable';
  }[];
}): Promise<{ readonly mismatches: string[]; readonly notes: string[] }> {
  const pg = await loadPg();
  const client = new pg.Client({ connectionString: input.db });
  try {
    await client.connect();
  } catch (cause) {
    throw new Error('PermDock CLI: rls verify --db could not connect', {
      cause,
    });
  }
  const dialect = input.config.rls?.dialect ?? 'supabase';
  const gucPrefix = input.config.rls?.gucPrefix ?? 'app';
  const tenantClaim = input.config.rls?.tenantClaim ?? 'tenant_id';
  const roleClaim = input.config.rls?.roleClaim ?? 'user_role';
  const rls = input.config.rls;
  const seedsTables =
    rls?.customRoles === true &&
    (rls.authorize ?? rls.rbac?.authorize ?? 'jwt') === 'database';
  const schema = rls?.schema ?? rls?.rbac?.schema ?? 'public';
  const query: QueryFn = async (sql, values) => {
    try {
      const result = await client.query(
        sql,
        values === undefined ? [] : [...values],
      );
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? result.rows.length,
      };
    } catch (cause) {
      const code =
        cause !== null &&
        typeof cause === 'object' &&
        'code' in cause &&
        typeof (cause as { readonly code: unknown }).code === 'string'
          ? (cause as { readonly code: string }).code
          : undefined;
      return { rows: [], rowCount: 0, ...(code === undefined ? {} : { code }) };
    }
  };
  const mismatches: string[] = [];
  const notes: string[] = [];
  try {
    for (const [index, fixture] of input.fixtures.entries()) {
      const permission = findPermission(
        input.policy.permissions,
        fixture.action,
      );
      const status = input.inProcess[index];
      if (permission === undefined || status === undefined) {
        continue;
      }
      if (status.kind === 'opaque') {
        notes.push(`${fixture.action}: opaque grant untestable app-side`);
        continue;
      }
      const table =
        input.config.rls?.tables?.[permission.resource] ?? permission.resource;
      await query('begin');
      try {
        if (seedsTables) {
          await seedCustomRoles(query, schema, input.customRoles);
        }
        await bindSubject(
          query,
          fixture,
          dialect,
          gucPrefix,
          tenantClaim,
          roleClaim,
          input.customRoles,
        );
        const statement = statementFor(fixture, permission.action, table);
        const result = await query(statement.sql, statement.values);
        const count = result.rowCount ?? result.rows.length;
        const database =
          result.code === '42501'
            ? 'rejected'
            : count > 0
              ? 'allowed'
              : 'filtered';
        const ok = status.granted
          ? database === 'allowed'
          : database === 'filtered' || database === 'rejected';
        if (!ok) {
          mismatches.push(
            `${fixture.action}: in-process ${status.granted ? 'granted' : 'denied'}, database ${database}`,
          );
        } else if (status.kind === 'sqlFunction') {
          notes.push(`${fixture.action}: verified through twin`);
        }
      } finally {
        await query('rollback');
      }
    }
  } finally {
    await client.end();
  }
  return { mismatches, notes };
}

export async function runRlsVerify(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly fixtures?: string;
  readonly db?: string;
  readonly from?: string;
  readonly format: 'node' | 'pgtap';
  readonly io: CliIo;
}): Promise<VerifyOutcome> {
  const policyPath = input.from ?? input.config.policy;
  if (policyPath === undefined) {
    return {
      code: 2,
      output: 'PermDock CLI: rls verify needs policy in the config or --from',
    };
  }
  const policy: Policy = asPolicy(
    pickNamed(await loadModule(resolve(input.cwd, policyPath)), ['policy']),
  );
  const fixturesPath =
    input.fixtures ?? input.config.rls?.fixtures ?? 'rls.fixtures.json';
  const { fixtures, customRoles } = await loadFixtures(input.cwd, fixturesPath);
  if (input.format === 'pgtap') {
    return { code: 0, output: emitPgtap(fixtures, customRoles) };
  }
  const mismatches: string[] = [];
  const notes: string[] = [];
  const inProcess: {
    readonly action: string;
    readonly granted: boolean;
    readonly kind: 'opaque' | 'sqlFunction' | 'portable';
  }[] = [];
  for (const fixture of fixtures) {
    const permission = findPermission(policy.permissions, fixture.action);
    if (permission === undefined) {
      mismatches.push(`${fixture.action}: unknown permission`);
      inProcess.push({
        action: fixture.action,
        granted: false,
        kind: 'portable',
      });
      continue;
    }
    const kind = grantKind(policy, fixture.action);
    const dock = await createPermDock(policy, toSubject(fixture.subject), {
      customRoles: memoryRoleSource(customRoles),
    });
    const granted = canFixture(
      dock,
      permission,
      fixture.newRow === undefined || permission.kind === 'collection'
        ? fixture.row
        : { current: fixture.row, next: fixture.newRow },
    );
    const outcome = granted ? 'granted' : 'denied';
    if (fixture.expected !== undefined && fixture.expected !== outcome) {
      mismatches.push(
        `${fixture.action}: in-process ${outcome}, expected ${fixture.expected}`,
      );
    }
    if (kind === 'opaque') {
      notes.push(`${fixture.action}: opaque grant untestable app-side`);
    }
    inProcess.push({ action: fixture.action, granted, kind });
  }
  if (input.db !== undefined) {
    try {
      const database = await verifyAgainstDatabase({
        db: input.db,
        policy,
        fixtures,
        customRoles,
        config: input.config,
        inProcess,
      });
      mismatches.push(...database.mismatches);
      notes.push(...database.notes);
    } catch (cause) {
      return {
        code: 2,
        output: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }
  if (mismatches.length > 0) {
    return { code: 1, output: [...mismatches, ...notes].join('\n') };
  }
  const verified = `verified ${fixtures.length} fixture(s) in-process`;
  return {
    code: 0,
    output: notes.length === 0 ? verified : `${verified}\n${notes.join('\n')}`,
  };
}
