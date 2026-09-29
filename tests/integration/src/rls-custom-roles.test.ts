import type { CustomRole } from 'permdock';

import { run } from '@permdock/cli';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { customRoleClaim } from 'permdock';
import { authorizeSql } from 'permdock/supabase';
import { rlsParity } from 'permdock/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { permissions } from '../fixtures/rls-custom-roles/permissions.ts';
import { policy } from '../fixtures/rls-custom-roles/policy.ts';
import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/rls-custom-roles');

const PLUS = '00000000-0000-4000-8000-0000000000a1';
const WRITER = '00000000-0000-4000-8000-0000000000b2';
const GRABBY = '00000000-0000-4000-8000-0000000000c3';
const REVIEWER = '00000000-0000-4000-8000-0000000000d4';
const GLOBEX = '00000000-0000-4000-8000-0000000000e5';
const SHADOW = '00000000-0000-4000-8000-0000000000f6';
const OTHER = '00000000-0000-4000-8000-000000000099';

const CUSTOM_ROLES: readonly CustomRole[] = [
  // Adds one permission and denies one.
  {
    tenant: 'acme',
    name: 'editor-plus',
    includes: ['viewer'],
    grants: [
      { permission: 'task.update' },
      { permission: 'project.read', effect: 'deny' },
    ],
  },
  { tenant: 'acme', name: 'writer', includes: ['member'] },
  {
    tenant: 'acme',
    name: 'grabby',
    includes: ['owner', 'auditor'],
    grants: [{ permission: 'project.delete' }],
  },
  {
    tenant: 'acme',
    team: 't1',
    name: 'reviewer',
    grants: [{ permission: 'board.read' }],
  },
  { tenant: 'globex', name: 'writer', grants: [{ permission: 'task.read' }] },
  { tenant: 'acme', name: 'viewer', grants: [{ permission: 'task.delete' }] },
];

type Membership = {
  readonly tenant: string;
  readonly team?: string;
  readonly roles: readonly string[];
};

type Subject = {
  readonly id: string;
  readonly tenant: string;
  readonly memberships: readonly Membership[];
};

const SUBJECTS: Readonly<Record<string, Subject>> = {
  plus: {
    id: PLUS,
    tenant: 'acme',
    memberships: [{ tenant: 'acme', roles: ['editor-plus'] }],
  },
  writer: {
    id: WRITER,
    tenant: 'acme',
    memberships: [{ tenant: 'acme', roles: ['writer'] }],
  },
  grabby: {
    id: GRABBY,
    tenant: 'acme',
    memberships: [{ tenant: 'acme', roles: ['grabby'] }],
  },
  reviewer: {
    id: REVIEWER,
    tenant: 'acme',
    memberships: [{ tenant: 'acme', team: 't1', roles: ['reviewer'] }],
  },
  globex: {
    id: GLOBEX,
    tenant: 'globex',
    memberships: [{ tenant: 'globex', roles: ['writer'] }],
  },
  shadow: {
    id: SHADOW,
    tenant: 'acme',
    memberships: [{ tenant: 'acme', roles: ['viewer'] }],
  },
};

const ROWS = {
  project: [
    { id: 'p-acme', orgId: 'acme', ownerId: WRITER },
    { id: 'p-other', orgId: 'acme', ownerId: OTHER },
    { id: 'p-globex', orgId: 'globex', ownerId: GLOBEX },
  ],
  task: [
    { id: 't-own', orgId: 'acme', authorId: WRITER, locked: false },
    { id: 't-other', orgId: 'acme', authorId: OTHER, locked: false },
    { id: 't-locked', orgId: 'acme', authorId: WRITER, locked: true },
    { id: 't-globex', orgId: 'globex', authorId: GLOBEX, locked: false },
  ],
  board: [
    { id: 'b-t1', orgId: 'acme', teamId: 't1' },
    { id: 'b-t2', orgId: 'acme', teamId: 't2' },
  ],
} as const;

const ACTIONS: Readonly<Record<keyof typeof ROWS, readonly string[]>> = {
  project: ['read', 'update', 'delete'],
  task: ['read', 'update', 'delete'],
  board: ['read', 'update'],
};

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
`;

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
  ('${PLUS}'), ('${WRITER}'), ('${GRABBY}'), ('${REVIEWER}'), ('${GLOBEX}'), ('${SHADOW}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create table public.team_members (
  team_id text not null,
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${PLUS}', 'editor-plus'),
  ('acme', '${WRITER}', 'writer'),
  ('acme', '${GRABBY}', 'grabby'),
  ('globex', '${GLOBEX}', 'writer'),
  ('acme', '${SHADOW}', 'viewer');
insert into public.team_members values ('t1', 'acme', '${REVIEWER}', 'reviewer');
create table public.project (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.task (
  id text primary key,
  "orgId" text not null,
  "authorId" uuid not null,
  locked boolean not null default false
);
create table public.board (id text primary key, "orgId" text not null, "teamId" text not null);
insert into public.project values
  ('p-acme', 'acme', '${WRITER}'), ('p-other', 'acme', '${OTHER}'), ('p-globex', 'globex', '${GLOBEX}');
insert into public.task values
  ('t-own', 'acme', '${WRITER}', false),
  ('t-other', 'acme', '${OTHER}', false),
  ('t-locked', 'acme', '${WRITER}', true),
  ('t-globex', 'globex', '${GLOBEX}', false);
insert into public.board values ('b-t1', 'acme', 't1'), ('b-t2', 'acme', 't2');
`;

// Spot checks that pin the matrix to intent, so a database that denies (or
// grants) everything cannot pass by agreeing with decide.
const EXPECTED: Readonly<Record<string, 'granted' | 'denied'>> = {
  'plus task.update t-other': 'granted',
  'plus task.update t-locked': 'denied',
  'plus task.read t-own': 'granted',
  'plus project.read p-acme': 'denied',
  'plus task.delete t-own': 'denied',
  'writer task.update t-own': 'granted',
  'writer task.update t-other': 'denied',
  'writer task.update t-locked': 'denied',
  'writer project.update p-acme': 'granted',
  'writer project.update p-other': 'denied',
  'writer task.read t-globex': 'denied',
  'grabby project.delete p-acme': 'denied',
  'grabby project.read p-acme': 'granted',
  'grabby project.read p-globex': 'denied',
  'reviewer board.read b-t1': 'granted',
  'reviewer board.read b-t2': 'denied',
  'reviewer board.update b-t1': 'denied',
  'globex task.read t-globex': 'granted',
  'globex task.update t-globex': 'denied',
  'shadow task.read t-own': 'granted',
  'shadow task.delete t-own': 'denied',
};

type Fixture = {
  readonly subject: Subject;
  readonly row: Readonly<Record<string, unknown>>;
  readonly action: string;
  readonly expected?: 'granted' | 'denied';
};

function fixtures(): readonly Fixture[] {
  const out: Fixture[] = [];
  for (const [name, subject] of Object.entries(SUBJECTS)) {
    for (const resource of Object.keys(ROWS) as (keyof typeof ROWS)[]) {
      for (const row of ROWS[resource]) {
        for (const action of ACTIONS[resource]) {
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
    }
  }
  return out;
}

const PERMISSION_KEYS = [
  'project.read',
  'project.update',
  'project.delete',
  'project.list',
  'project.create',
  'task.read',
  'task.update',
  'task.delete',
  'task.list',
  'task.create',
  'board.read',
  'board.update',
];
const DECLARED = ['admin', 'auditor', 'lead', 'member', 'owner', 'viewer'];

const SHAPES = [
  { name: 'custom_database', cwd: FIXTURE },
  { name: 'custom_jwt', cwd: join(FIXTURE, 'jwt') },
] as const;

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

describe('custom roles in generated RLS (database and jwt modes)', () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), 'permdock-custom-roles-'));
  const fixturesPath = join(dir, 'rls.fixtures.json');
  const generated: Record<string, string> = {};

  beforeAll(async () => {
    writeFileSync(
      fixturesPath,
      `${JSON.stringify({ fixtures: fixtures(), customRoles: CUSTOM_ROLES }, null, 2)}\n`,
    );
    db = await startPostgres([ROLES]);
    for (const shape of SHAPES) {
      const out = join(dir, `${shape.name}.sql`);
      const result = await run(
        ['rls', 'generate', '--target', 'sql', '--out', out],
        { cwd: shape.cwd },
      );
      if (result.code !== 0) {
        throw new Error(`rls generate ${shape.name}: ${result.stdout}`);
      }
      generated[shape.name] = readFileSync(out, 'utf8');
      await db.admin.query(`create database ${shape.name}`);
      const client = new Client({
        connectionString: databaseUri(db.uri, shape.name),
      });
      await client.connect();
      try {
        await client.query(
          [
            STUB,
            generated[shape.name] ?? '',
            `create type public.app_permission as enum (${PERMISSION_KEYS.map((key) => `'${key}'`).join(', ')});`,
            authorizeSql({
              authorize: shape.name === 'custom_database' ? 'database' : 'jwt',
              tenant: {
                table: 'organization_members',
                tenant: 'organization_id',
                user: 'user_id',
                role: 'role',
              },
              customRoles: { declared: DECLARED },
            }),
            'grant execute on function public.authorize(public.app_permission, text) to authenticated;',
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

  it('emits the tables in database mode, the ceiling view in both', () => {
    const database = generated.custom_database ?? '';
    const jwt = generated.custom_jwt ?? '';
    expect(database).toContain(
      'create table if not exists "public".custom_role_permissions',
    );
    expect(database).toContain(
      'create table if not exists "public".custom_role_includes',
    );
    expect(jwt).not.toContain('custom_role_permissions');
    for (const sql of [database, jwt]) {
      expect(sql).toContain('create or replace view "public".permdock_ceiling');
      expect(sql).toContain(
        "array['admin', 'lead', 'member', 'viewer']::text[]",
      );
      expect(sql).not.toMatch(/service_role/iu);
    }
  });

  it.each(SHAPES)(
    '$name: the database agrees with decide for every custom role, table and command',
    async (shape) => {
      if (db === undefined) {
        throw new Error('PermDock: Postgres was not started');
      }
      const result = await run(
        [
          'rls',
          'verify',
          '--db',
          // Database mode seeds each fixture's custom roles, which needs the
          // table owner; the checked statement still runs as authenticated.
          shape.name === 'custom_database'
            ? databaseUri(db.uri, shape.name)
            : testerUri(db.uri, shape.name),
          '--fixtures',
          fixturesPath,
        ],
        { cwd: shape.cwd },
      );
      expect(result.stdout).toContain(
        `verified ${String(fixtures().length)} fixture(s)`,
      );
      expect(result.code).toBe(0);
    },
  );

  it('a row inserted outside the ceiling never widens access', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const client = new Client({
      connectionString: databaseUri(db.uri, 'custom_database'),
    });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into public.custom_role_permissions (tenant_id, role, permission) values ('acme', 'grabby', 'project.delete')`,
      );
      await client.query(
        `insert into public.custom_role_includes (tenant_id, role, include_role) values ('acme', 'grabby', 'owner'), ('acme', 'grabby', 'auditor')`,
      );
      await client.query('set local role authenticated');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: GRABBY, role: 'authenticated' }),
      ]);
      const deleted = await client.query(
        `delete from public.project where id = 'p-acme' returning id`,
      );
      expect(deleted.rowCount).toBe(0);
      const read = await client.query(
        `select id from public.project order by id`,
      );
      expect(read.rows.map((row: { id: string }) => row.id)).toEqual([
        'p-acme',
        'p-other',
      ]);
      await client.query('rollback');
    } finally {
      await client.end();
    }
  });

  it('rlsParity carries the grants claim in jwt mode', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const client = new Client({
      connectionString: testerUri(db.uri, 'custom_jwt'),
    });
    await client.connect();
    try {
      const report = await rlsParity(policy, {
        dialect: 'supabase',
        customRoles: CUSTOM_ROLES,
        fixtures: [
          {
            name: 'plus updates another task',
            subject: SUBJECTS.plus!,
            permission: permissions.task.update,
            row: ROWS.task[1],
            table: 'task',
          },
          {
            name: 'plus cannot read projects',
            subject: SUBJECTS.plus!,
            permission: permissions.project.read,
            row: ROWS.project[0],
            table: 'project',
          },
          {
            name: 'reviewer reads its team board',
            subject: SUBJECTS.reviewer!,
            permission: permissions.board.read,
            row: ROWS.board[0],
            table: 'board',
          },
        ],
        query: async (sql, values) => {
          const result = await client.query(
            sql,
            values === undefined ? undefined : [...values],
          );
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
      });
      expect(report.results).toEqual([
        {
          name: 'plus updates another task',
          granted: true,
          database: 'allowed',
          ok: true,
        },
        {
          name: 'plus cannot read projects',
          granted: false,
          database: 'filtered',
          ok: true,
        },
        {
          name: 'reviewer reads its team board',
          granted: true,
          database: 'allowed',
          ok: true,
        },
      ]);
    } finally {
      await client.end();
    }
  });

  it.each(SHAPES)(
    '$name: authorize() answers tenant requests from custom roles',
    async (shape) => {
      if (db === undefined) {
        throw new Error('PermDock: Postgres was not started');
      }
      const client = new Client({
        connectionString: databaseUri(db.uri, shape.name),
      });
      await client.connect();
      try {
        await client.query('begin');
        if (shape.name === 'custom_database') {
          await client.query(`insert into public.custom_role_permissions (tenant_id, role, permission, effect) values
            ('acme', 'editor-plus', 'task.update', 'allow'),
            ('acme', 'editor-plus', 'project.read', 'deny'),
            ('acme', 'grabby', 'project.delete', 'allow')`);
          await client.query(`insert into public.custom_role_includes (tenant_id, role, include_role) values
            ('acme', 'editor-plus', 'viewer')`);
        }
        await client.query('set local role authenticated');
        const ask = async (
          sub: string,
          role: string,
          permission: string,
        ): Promise<boolean> => {
          const held = CUSTOM_ROLES.filter(
            (item) => item.tenant === 'acme' && item.name === role,
          );
          await client.query(
            `select set_config('request.jwt.claims', $1, true)`,
            [
              JSON.stringify({
                sub,
                role: 'authenticated',
                memberships: [
                  {
                    tenant: 'acme',
                    roles: [role],
                    grants: customRoleClaim(held),
                  },
                ],
              }),
            ],
          );
          const result = await client.query<{ ok: boolean }>(
            `select public.authorize($1::public.app_permission, 'acme') as ok`,
            [permission],
          );
          return result.rows[0]?.ok ?? false;
        };
        expect(await ask(PLUS, 'editor-plus', 'task.update')).toBe(true);
        expect(await ask(PLUS, 'editor-plus', 'task.read')).toBe(true);
        expect(await ask(PLUS, 'editor-plus', 'project.read')).toBe(false);
        expect(await ask(PLUS, 'editor-plus', 'task.delete')).toBe(false);
        expect(await ask(GRABBY, 'grabby', 'project.delete')).toBe(false);
        await client.query('rollback');
      } finally {
        await client.end();
      }
    },
  );
});
