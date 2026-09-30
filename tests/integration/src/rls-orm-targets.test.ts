import { getTableName, is, type SQL } from 'drizzle-orm';
import { PgDialect, PgPolicy, PgRole, type PgTable } from 'drizzle-orm/pg-core';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPermDock } from 'permdock';
import { run } from 'permdock/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import {
  graphPolicy,
  permissions,
  relations,
  rows,
  schemaSql,
  seedSql,
  users,
} from '../fixtures/workspace/policy.ts';
import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/workspace');
const CACHE = join(HERE, '../node_modules/.cache');

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
grant usage on schema public to authenticated, anon;
`;

const TABLES = ['doc', 'folder', 'team'] as const;
type Table = (typeof TABLES)[number];

const SCHEMA = `import { pgTable, text } from 'drizzle-orm/pg-core'
${TABLES.map((table) => `export const ${table} = pgTable('${table}', { id: text('id').primaryKey() })`).join('\n')}
`;

const reads = {
  doc: permissions.doc.read,
  folder: permissions.folder.read,
  team: permissions.team.read,
} as const;

type Created = {
  readonly name: string;
  readonly table: string;
  readonly as: string;
  readonly command: string;
  readonly roles: readonly string[];
  readonly using?: string | undefined;
  readonly check?: string | undefined;
};

function createSql(policy: Created): string {
  return [
    `create policy "${policy.name}" on public."${policy.table}"`,
    `as ${policy.as} for ${policy.command} to ${policy.roles.join(', ')}`,
    policy.using === undefined ? '' : `using (${policy.using})`,
    policy.check === undefined ? '' : `with check (${policy.check})`,
  ].join(' ');
}

function roleNames(to: PgPolicy['to']): string[] {
  const list: readonly unknown[] = Array.isArray(to) ? to : [to];
  return list.map((role) => {
    if (is(role, PgRole)) {
      return role.name;
    }
    if (typeof role !== 'string') {
      throw new TypeError('PermDock: unexpected pgPolicy role');
    }
    return role;
  });
}

function drizzlePolicies(module: Record<string, unknown>): Created[] {
  const dialect = new PgDialect();
  const text = (value: SQL | undefined): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const query = dialect.sqlToQuery(value);
    expect(query.params).toEqual([]);
    return query.sql;
  };
  return Object.values(module)
    .filter((value): value is PgPolicy => is(value, PgPolicy))
    .map((policy) => {
      const linked = Reflect.get(policy, '_linkedTable') as PgTable | undefined;
      if (linked === undefined) {
        throw new Error(`PermDock: ${policy.name} is not linked to a table`);
      }
      return {
        name: policy.name,
        table: getTableName(linked),
        as: policy.as ?? 'permissive',
        command: policy.for ?? 'all',
        roles: roleNames(policy.to),
        using: text(policy.using),
        check: text(policy.withCheck),
      };
    });
}

const MODELS: Readonly<Record<string, Table>> = {
  Doc: 'doc',
  Folder: 'folder',
  Team: 'team',
};

function prismaPolicies(text: string): Created[] {
  const blocks = text.matchAll(
    /^policy_(select|insert|update|delete|all) (\w+) \{\n([\s\S]*?)\n\}/gmu,
  );
  return [...blocks].map(([, command, name, body]) => {
    const fields = new Map(
      (body ?? '')
        .split('\n')
        .map((line) => /^ {2}(\w+)\s*= (.*)$/u.exec(line))
        .filter((match) => match !== null)
        .map((match) => [match[1], match[2]] as const),
    );
    const model = fields.get('target') ?? '';
    const table = MODELS[model];
    if (table === undefined) {
      throw new Error(`PermDock: unknown Prisma model ${model}`);
    }
    const string = (key: string): string | undefined => {
      const value = fields.get(key);
      return value === undefined ? undefined : (JSON.parse(value) as string);
    };
    return {
      name: name ?? '',
      table,
      as: 'permissive',
      command: command ?? '',
      roles: (fields.get('roles') ?? '[]')
        .slice(1, -1)
        .split(',')
        .map((role) => role.trim()),
      using: string('using'),
      check: string('withCheck'),
    };
  });
}

async function generate(
  dir: string,
  target: string,
  out: string,
): Promise<string> {
  const result = await run(
    ['rls', 'generate', '--target', target, '--out', join(dir, out)],
    { cwd: FIXTURE },
  );
  if (result.code !== 0) {
    throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
  }
  return readFileSync(join(dir, out), 'utf8');
}

async function visible(
  db: Postgres,
  sub: string,
  table: Table,
): Promise<string[]> {
  return db.as(
    { role: 'authenticated', settings: { 'app.user_id': sub } },
    async () =>
      (
        await db.tester.query<{ id: string }>(
          `select id from public.${table} order by id`,
        )
      ).rows.map((row) => row.id),
  );
}

async function inProcess(sub: string, table: Table): Promise<string[]> {
  const dock = await createPermDock(graphPolicy, { id: sub }, { relations });
  await dock.loadRelations(reads[table], rows[table]);
  return rows[table]
    .filter((row) => dock.can(reads[table], row as never))
    .map((row) => row.id)
    .toSorted();
}

async function mismatches(db: Postgres): Promise<string[]> {
  const found: string[] = [];
  for (const user of users.filter((item) => item.memberships === undefined)) {
    for (const table of TABLES) {
      const got = await visible(db, user.id, table);
      const want = await inProcess(user.id, table);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        found.push(
          `${user.id} ${table}: rls [${got.join(',')}] can [${want.join(',')}]`,
        );
      }
    }
  }
  return found;
}

describe('rls generate --target drizzle and prisma against Postgres', () => {
  let db: Postgres | undefined;
  mkdirSync(CACHE, { recursive: true });
  const dir = mkdtempSync(join(CACHE, 'permdock-orm-targets-'));
  let drizzleText = '';
  let prismaText = '';

  beforeAll(async () => {
    writeFileSync(join(dir, 'schema.ts'), SCHEMA);
    drizzleText = await generate(dir, 'drizzle', 'policies.ts');
    const drizzleMigration = readFileSync(
      join(dir, 'policies.migration.sql'),
      'utf8',
    );
    prismaText = await generate(dir, 'prisma', 'policies.prisma');
    if (
      readFileSync(join(dir, 'policies.migration.sql'), 'utf8') !==
      drizzleMigration
    ) {
      throw new Error(
        'the drizzle and prisma targets wrote different migrations',
      );
    }
    db = await startPostgres([ROLES, schemaSql, drizzleMigration, seedSql]);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  async function apply(policies: readonly Created[]): Promise<void> {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    await db.admin.query(
      TABLES.map(
        (table) =>
          `do $$ declare p record; begin for p in select policyname from pg_policies where tablename = '${table}' loop execute format('drop policy %I on public.${table}', p.policyname); end loop; end $$`,
      ).join(';\n'),
    );
    await db.admin.query(policies.map(createSql).join(';\n'));
  }

  it('links every Drizzle policy to its table and matches can()', async () => {
    const module = (await import(join(dir, 'policies.ts'))) as Record<
      string,
      unknown
    >;
    const policies = drizzlePolicies(module);
    expect(new Set(policies.map((policy) => policy.table))).toEqual(
      new Set(TABLES),
    );
    expect(drizzleText).toContain("from 'drizzle-orm/pg-core'");
    await apply(policies);
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    expect(await mismatches(db)).toEqual([]);
    expect(await visible(db, 'lena', 'doc')).toEqual(['deep-doc']);
  });

  it('emits Prisma 8 policy blocks whose predicates match can()', async () => {
    expect(prismaText).toMatch(
      /^\/\/ add @@rls to models Doc, Folder, Team;/mu,
    );
    const policies = prismaPolicies(prismaText);
    expect(policies.length).toBeGreaterThan(0);
    await apply(policies);
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    expect(await mismatches(db)).toEqual([]);
    expect(await visible(db, 'otto', 'team')).toEqual([
      'eng-team',
      'oncall',
      'sre',
    ]);
  });
});
