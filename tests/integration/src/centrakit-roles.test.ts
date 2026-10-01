import type { Client } from 'pg';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'permdock/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/centrakit-roles');

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const PLATFORM = id(0xa1);
const OTHER = id(0xa2);
const PLATFORM_ROLE = id(0xe1);
const SUPPORT_ROLE = id(0xe2);

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
grant authenticated, anon, supabase_auth_admin to tester;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to supabase_auth_admin, authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
grant select on auth.users to supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${PLATFORM}'), ('${OTHER}');
create table organizations (id uuid primary key, disabled_at timestamptz);
create table profiles (user_id uuid primary key, disabled_at timestamptz);
insert into profiles (user_id) select id from auth.users;
create table memberships (
  user_id uuid not null, scope text not null, scope_id uuid not null, role text not null,
  via text, expires_at timestamptz
);
create table contacts (
  id uuid primary key, organization_id uuid not null, customer_id uuid not null, user_id uuid
);
create table roles (id uuid primary key, key text not null unique, label text);
alter table roles enable row level security;
insert into roles values ('${PLATFORM_ROLE}', 'platform-admin', 'Platform'), ('${SUPPORT_ROLE}', 'support', 'Support');
create table user_roles (user_id uuid not null, role_id uuid not null references roles (id));
alter table user_roles enable row level security;
insert into user_roles values ('${PLATFORM}', '${PLATFORM_ROLE}'), ('${OTHER}', '${SUPPORT_ROLE}');
`;

type Claims = Record<string, unknown>;

describe('CentraKit global roles through roles.key', () => {
  let db: Postgres | undefined;
  let sql = '';

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'permdock-roles-'));
    try {
      const result = await run(
        [
          'rls',
          'generate',
          '--target',
          'sql',
          '--split',
          'helpers,hook',
          '--out',
          join(dir, '{part}.sql'),
        ],
        { cwd: FIXTURE },
      );
      if (result.code !== 0) {
        throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
      }
      const parts = ['helpers', 'hook'].map((part) =>
        readFileSync(join(dir, `${part}.sql`), 'utf8'),
      );
      sql = parts.join('\n');
      db = await startPostgres([SETUP, ...parts]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  function as<T>(
    role: 'authenticated' | 'supabase_auth_admin',
    claims: Claims,
    work: (client: Client) => Promise<T>,
  ): Promise<T> {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const client = db.tester;
    return db.as(
      { role, settings: { 'request.jwt.claims': JSON.stringify(claims) } },
      () => work(client),
    );
  }

  const mint = (user: string) =>
    as('supabase_auth_admin', {}, async (client) => {
      const result = await client.query<{ event: { claims: Claims } }>(
        'select public.custom_access_token_hook($1::jsonb) as event',
        [JSON.stringify({ user_id: user, claims: { sub: user } })],
      );
      return result.rows[0]?.event.claims ?? {};
    });

  const has = (user: string, key: string) =>
    as('authenticated', { sub: user }, async (client) => {
      const result = await client.query<{ ok: boolean }>(
        'select public.permdock_has($1) as ok',
        [key],
      );
      return result.rows[0]?.ok;
    });

  const version = async (user: string) => {
    const result = await db?.admin.query<{ version: string }>(
      'select version from public.permdock_authz_version where user_id = $1',
      [user],
    );
    return Number(result?.rows[0]?.version ?? 0);
  };

  it('reads the key through the roles table and creates no user_roles of its own', () => {
    expect(sql).toContain(
      'join "public"."roles" urk on urk."id" = ur."role_id"',
    );
    expect(sql).not.toMatch(/create table if not exists "public"\.user_roles/u);
  });

  it('mints the role keys and answers permdock_has from them', async () => {
    expect(await mint(PLATFORM)).toMatchObject({
      user_role: 'platform-admin',
      roles: ['platform-admin'],
    });
    expect(await mint(OTHER)).toMatchObject({ roles: ['support'] });
    expect(await has(PLATFORM, 'organizations.read')).toBe(true);
    expect(await has(OTHER, 'organizations.read')).toBe(false);
  });

  it("bumps every holder's version when a role key is renamed", async () => {
    const before = await version(PLATFORM);
    const other = await version(OTHER);
    await db?.admin.query(
      `update roles set label = 'Platform team' where id = $1`,
      [PLATFORM_ROLE],
    );
    expect(await version(PLATFORM)).toBe(before);
    await db?.admin.query(
      `update roles set key = 'platform-operator' where id = $1`,
      [PLATFORM_ROLE],
    );
    expect(await version(PLATFORM)).toBe(before + 1);
    expect(await version(OTHER)).toBe(other);
    expect(await has(PLATFORM, 'organizations.read')).toBe(false);
    expect(await mint(PLATFORM)).toMatchObject({
      roles: ['platform-operator'],
    });
  });
});
