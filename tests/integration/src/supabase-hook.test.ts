import type { Client } from 'pg';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPermDock } from 'permdock';
import { run } from 'permdock/cli';
import { subjectFromSupabase } from 'permdock/supabase';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import {
  assets,
  documents,
  permissions,
  policy,
} from '../fixtures/named-scopes/policy.ts';
import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/named-scopes/supabase');

const OWNER = '00000000-0000-4000-8000-000000000001';
const STAFF = '00000000-0000-4000-8000-000000000002';
const PRIVATE = '00000000-0000-4000-8000-000000000003';
const BUSINESS = '00000000-0000-4000-8000-000000000004';
const LAPSED = '00000000-0000-4000-8000-000000000005';
const SUSPENDED = '00000000-0000-4000-8000-000000000006';
const USERS = [OWNER, STAFF, PRIVATE, BUSINESS, LAPSED, SUSPENDED];

const values = (rows: readonly Record<string, string>[], keys: string[]) =>
  rows
    .map((row) => `(${keys.map((key) => `'${row[key] ?? ''}'`).join(', ')})`)
    .join(', ');

// Organization B is disabled, customer G is archived, LAPSED's contact row has expired and SUSPENDED's profile is disabled.
const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
grant authenticated, anon, supabase_auth_admin to tester;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon, supabase_auth_admin;
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ${USERS.map((id) => `('${id}')`).join(', ')};
create table organization_users (organization_id text not null, user_id uuid not null, role text not null);
create table customer_contacts (
  customer_id text not null, organization_id text not null, user_id uuid not null, role text not null,
  expires_at timestamptz
);
insert into organization_users values
  ('T', '${OWNER}', 'owner'), ('B', '${OWNER}', 'owner'),
  ('T', '${STAFF}', 'member'), ('T', '${SUSPENDED}', 'admin');
insert into customer_contacts values
  ('A', 'T', '${PRIVATE}', 'contact', null), ('G', 'T', '${BUSINESS}', 'contact', null),
  ('C', 'B', '${STAFF}', 'contact', null), ('A', 'T', '${LAPSED}', 'contact', now() - interval '1 day');
create table organization (id text primary key, disabled_at timestamptz);
insert into organization values ('T', null), ('B', now());
create table customer (id text primary key, status text);
insert into customer values ('A', 'active'), ('G', 'archived'), ('C', 'active'), ('D', 'prospect');
create table profiles (id uuid primary key, disabled_at timestamptz);
insert into profiles select id, null from auth.users;
update profiles set disabled_at = now() where id = '${SUSPENDED}';
create table quote (id text primary key, organization_id text not null, customer_id text not null, status text not null);
create table invoice (id text primary key, organization_id text not null, customer_id text not null, status text not null);
create table asset (id text primary key, organization_id text not null, customer_id text not null);
insert into quote values ${values(documents, ['id', 'organization_id', 'customer_id', 'status'])};
insert into invoice values ${values(documents, ['id', 'organization_id', 'customer_id', 'status'])};
insert into asset values ${values(assets, ['id', 'organization_id', 'customer_id'])};
grant select, insert, update, delete on quote, invoice, asset to authenticated;
`;

type Claims = Record<string, unknown>;

describe('Supabase token hook with named scopes (jwt mode)', () => {
  let db: Postgres | undefined;
  let generated = '';

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'permdock-hook-'));
    const out = join(dir, 'rls.sql');
    const result = await run(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--rbac',
        'supabase',
        '--out',
        out,
      ],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    generated = readFileSync(out, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([
      SETUP,
      generated,
      `insert into public.user_roles values ('${SUSPENDED}', 'platform-support')`,
    ]);
  }, 120_000);

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

  async function mint(user: string): Promise<Claims> {
    const event = JSON.stringify({
      user_id: user,
      claims: { sub: user, role: 'authenticated', aal: 'aal1' },
    });
    return as(
      'supabase_auth_admin',
      { role: 'supabase_auth_admin' },
      async (client) => {
        const result = await client.query<{ event: { claims: Claims } }>(
          'select public.custom_access_token_hook($1::jsonb) as event',
          [event],
        );
        const claims = result.rows[0]?.event.claims;
        if (claims === undefined) {
          throw new Error('PermDock: the hook returned no claims');
        }
        return claims;
      },
    );
  }

  it('writes the canonical memberships claim, without suspended or lapsed entries', async () => {
    expect((await mint(OWNER))['memberships']).toEqual([
      { scope: 'organization', id: 'T', roles: ['owner'] },
    ]);
    expect((await mint(STAFF))['memberships']).toEqual([
      { scope: 'organization', id: 'T', roles: ['member'] },
    ]);
    expect((await mint(PRIVATE))['memberships']).toEqual([
      {
        scope: 'customer',
        id: 'A',
        within: { organization: 'T' },
        roles: ['contact'],
      },
    ]);
    expect((await mint(BUSINESS))['memberships']).toEqual([]);
    expect((await mint(LAPSED))['memberships']).toEqual([]);
  });

  it('empties the role and memberships claims of a suspended user', async () => {
    const claims = await mint(SUSPENDED);
    expect(claims['user_role']).toEqual([]);
    expect(claims['memberships']).toEqual([]);
    const subject = subjectFromSupabase(
      { ...claims, app_metadata: { user_role: 'platform-support' } },
      { memberships: 'memberships' },
    );
    expect(subject.principal?.roles ?? []).toEqual([]);
  });

  it('agrees with subjectFromSupabase on the claims it minted', async () => {
    for (const user of USERS) {
      const claims = { ...(await mint(user)), tenant_id: 'T' };
      const principal = subjectFromSupabase(claims, {
        memberships: 'memberships',
      }).principal;
      const dock = await createPermDock(policy, principal);
      for (const [permission, table] of [
        [permissions.quote.read, 'quote'],
        [permissions.invoice.read, 'invoice'],
        [permissions.asset.read, 'asset'],
      ] as const) {
        const rows = table === 'asset' ? assets : documents;
        const expected = rows
          .filter((row) => dock.can(permission, row))
          .map((row) => row.id)
          .toSorted();
        const actual = await as('authenticated', claims, async (client) =>
          (
            await client.query<{ id: string }>(
              `select id from public.${table} order by id`,
            )
          ).rows.map((row) => row.id),
        );
        if (user === OWNER && table === 'quote') {
          expect(actual).toEqual([
            'd_a_accepted',
            'd_a_draft',
            'd_a_sent',
            'd_g_sent',
          ]);
        }
        expect({ user, table, rows: actual.toSorted() }).toEqual({
          user,
          table,
          rows: expected,
        });
      }
    }
  });

  it('lets only supabase_auth_admin run the hook and never emits service_role', async () => {
    expect(generated).not.toMatch(/service_role/iu);
    await expect(
      as(
        'authenticated',
        { sub: OWNER, role: 'authenticated' },
        async (client) => {
          await client.query(
            'select public.custom_access_token_hook($1::jsonb)',
            [JSON.stringify({ user_id: OWNER, claims: {} })],
          );
        },
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
