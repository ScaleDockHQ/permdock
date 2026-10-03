import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'permdock/cli';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/rls-matrix');

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const MEMBER = '00000000-0000-4000-8000-0000000000b2';
const VIEWER = '00000000-0000-4000-8000-0000000000c3';
const OUTSIDER = '00000000-0000-4000-8000-0000000000d4';
const AUDITOR = '00000000-0000-4000-8000-0000000000e5';

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
`;

// The parts of a Supabase database the generated SQL relies on, per database.
const STUB = `
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon, tester;
insert into auth.users (id) values
  ('${ADMIN}'), ('${MEMBER}'), ('${VIEWER}'), ('${OUTSIDER}'), ('${AUDITOR}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${ADMIN}', 'admin'),
  ('acme', '${MEMBER}', 'member'),
  ('acme', '${VIEWER}', 'viewer'),
  ('globex', '${OUTSIDER}', 'member');
create table public.project (
  id text primary key,
  "orgId" text not null,
  "ownerId" uuid not null
);
create table public.task (
  id text primary key,
  "orgId" text not null,
  "authorId" uuid not null,
  locked boolean not null default false
);
insert into public.project values
  ('p-acme', 'acme', '${MEMBER}'),
  ('p-admin', 'acme', '${ADMIN}'),
  ('p-globex', 'globex', '${OUTSIDER}');
insert into public.task values
  ('t-own', 'acme', '${MEMBER}', false),
  ('t-other', 'acme', '${ADMIN}', false),
  ('t-locked', 'acme', '${MEMBER}', true),
  ('t-globex', 'globex', '${OUTSIDER}', false);
`;

type Subject = {
  readonly id: string;
  readonly roles?: readonly string[];
  readonly tenant?: string;
  readonly memberships?: readonly {
    readonly tenant: string;
    readonly roles: readonly string[];
  }[];
};

const SUBJECTS: Readonly<Record<string, Subject>> = {
  admin: {
    id: ADMIN,
    tenant: 'acme',
    memberships: [{ tenant: 'acme', roles: ['admin'] }],
  },
  member: {
    id: MEMBER,
    tenant: 'acme',
    memberships: [{ tenant: 'acme', roles: ['member'] }],
  },
  viewer: {
    id: VIEWER,
    tenant: 'acme',
    memberships: [{ tenant: 'acme', roles: ['viewer'] }],
  },
  outsider: {
    id: OUTSIDER,
    tenant: 'globex',
    memberships: [{ tenant: 'globex', roles: ['member'] }],
  },
  auditor: { id: AUDITOR, roles: ['auditor'] },
};

const PROJECTS = [
  { id: 'p-acme', orgId: 'acme', ownerId: MEMBER },
  { id: 'p-admin', orgId: 'acme', ownerId: ADMIN },
  { id: 'p-globex', orgId: 'globex', ownerId: OUTSIDER },
];
const TASKS = [
  { id: 't-own', orgId: 'acme', authorId: MEMBER, locked: false },
  { id: 't-other', orgId: 'acme', authorId: ADMIN, locked: false },
  { id: 't-locked', orgId: 'acme', authorId: MEMBER, locked: true },
  { id: 't-globex', orgId: 'globex', authorId: OUTSIDER, locked: false },
];

type Fixture = {
  readonly subject: Subject;
  readonly row: Readonly<Record<string, unknown>>;
  readonly action: string;
  readonly expected?: 'granted' | 'denied';
};

// Spot checks that pin the matrix to intent, so a matrix that denies (or
// grants) everything cannot pass by agreeing with itself.
const EXPECTED: Readonly<Record<string, 'granted' | 'denied'>> = {
  'admin task.update t-other': 'granted',
  'admin task.update t-locked': 'granted',
  'member task.update t-own': 'granted',
  'member task.update t-other': 'denied',
  'member task.update t-locked': 'denied',
  'member task.delete t-locked': 'granted',
  'member project.update p-acme': 'granted',
  'member project.update p-admin': 'denied',
  'viewer task.read t-own': 'granted',
  'viewer task.update t-own': 'denied',
  'outsider task.read t-own': 'denied',
  'outsider task.read t-globex': 'granted',
  'admin project.read p-globex': 'denied',
  'auditor task.read t-globex': 'granted',
  'auditor task.update t-own': 'denied',
  'auditor task.create new': 'denied',
  'member task.create new': 'granted',
  'viewer task.create new': 'denied',
};

function fixtures(): readonly Fixture[] {
  const out: Fixture[] = [];
  for (const [name, subject] of Object.entries(SUBJECTS)) {
    const tables = [
      ['project', PROJECTS],
      ['task', TASKS],
    ] as const;
    for (const [resource, rows] of tables) {
      for (const row of rows) {
        for (const action of ['read', 'update', 'delete']) {
          const label = `${name} ${resource}.${action} ${row.id}`;
          out.push({
            subject,
            row,
            action: `${resource}.${action}`,
            ...(EXPECTED[label] === undefined
              ? {}
              : { expected: EXPECTED[label] }),
          });
        }
      }
      const created =
        resource === 'project'
          ? { id: `new-${name}`, orgId: 'acme', ownerId: subject.id }
          : {
              id: `new-${name}`,
              orgId: 'acme',
              authorId: subject.id,
              locked: false,
            };
      const label = `${name} ${resource}.create new`;
      out.push({
        subject,
        row: created,
        action: `${resource}.create`,
        ...(EXPECTED[label] === undefined ? {} : { expected: EXPECTED[label] }),
      });
    }
  }
  return out;
}

type Shape = {
  readonly name: string;
  readonly mode: 'database' | 'jwt';
  readonly perRole: boolean;
};

const SHAPES: readonly Shape[] = [
  { name: 'collapsed_database', mode: 'database', perRole: false },
  { name: 'per_role_database', mode: 'database', perRole: true },
  { name: 'collapsed_jwt', mode: 'jwt', perRole: false },
  { name: 'per_role_jwt', mode: 'jwt', perRole: true },
];

function shapeFlags(shape: Shape): readonly string[] {
  return [
    '--authorize',
    shape.mode,
    ...(shape.perRole ? ['--policy-per-role'] : []),
  ];
}

function databaseUri(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}

function testerUri(uri: string, database: string): string {
  const url = new URL(databaseUri(uri, database));
  url.username = 'tester';
  url.password = 'tester';
  return url.toString();
}

describe('rls verify matrix (admin, member, viewer, non-member, global role)', () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), 'permdock-matrix-'));
  const fixturesPath = join(dir, 'rls.fixtures.json');

  beforeAll(async () => {
    writeFileSync(fixturesPath, `${JSON.stringify(fixtures(), null, 2)}\n`);
    db = await startPostgres([ROLES]);
    for (const shape of SHAPES) {
      const out = join(dir, `${shape.name}.sql`);
      const generated = await run(
        [
          'rls',
          'generate',
          '--target',
          'sql',
          ...shapeFlags(shape),
          '--out',
          out,
        ],
        { cwd: FIXTURE },
      );
      if (generated.code !== 0) {
        throw new Error(`rls generate ${shape.name}: ${generated.stdout}`);
      }
      await db.admin.query(`create database ${shape.name}`);
      const client = new Client({
        connectionString: databaseUri(db.uri, shape.name),
      });
      await client.connect();
      try {
        await client.query(
          [
            STUB,
            readFileSync(out, 'utf8'),
            shape.mode === 'database'
              ? `insert into permdock.user_roles (user_id, role) values ('${AUDITOR}', 'auditor');`
              : '',
          ].join('\n'),
        );
      } finally {
        await client.end();
      }
    }
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  it.each(SHAPES)(
    '$name: the database agrees with can() for every table and command',
    async (shape) => {
      if (db === undefined) {
        throw new Error('PermDock: Postgres was not started');
      }
      const result = await run(
        [
          'rls',
          'verify',
          '--db',
          testerUri(db.uri, shape.name),
          '--fixtures',
          fixturesPath,
        ],
        { cwd: FIXTURE },
      );
      expect(result.stdout).toContain(
        `verified ${String(fixtures().length)} fixture(s)`,
      );
      expect(result.code).toBe(0);
    },
  );

  it('reads the live policies back to roles with rls import --db', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    for (const shape of ['collapsed_database', 'per_role_database']) {
      const out = join(dir, `${shape}.generated.ts`);
      const imported = await run(
        ['rls', 'import', '--db', databaseUri(db.uri, shape), '--out', out],
        { cwd: FIXTURE },
      );
      expect(imported.code).toBe(0);
      const text = readFileSync(out, 'utf8');
      const json = /export const catalog = ([\s\S]*?) as const/u.exec(
        text,
      )?.[1];
      // SAFETY: the generated catalog literal is JSON in this shape
      const catalog = JSON.parse(json ?? '[]') as readonly {
        readonly table: string;
        readonly cmd: string;
        readonly grants?: readonly {
          readonly permission: string;
          readonly scope: string;
          readonly roles: readonly string[];
        }[];
      }[];
      const grants = new Set(
        catalog
          .filter((entry) => entry.table === 'task')
          .flatMap((entry) =>
            (entry.grants ?? []).map(
              (grant) =>
                `${entry.cmd} ${grant.permission} ${grant.scope} ${grant.roles.join('+')}`,
            ),
          ),
      );
      expect(grants).toContain('SELECT task.read global auditor');
      expect(grants).toContain('SELECT task.read tenant admin+member+viewer');
      expect(grants).toContain('UPDATE task.update tenant member');
      expect(grants).toContain('DELETE task.delete tenant admin');
    }
  });
});
