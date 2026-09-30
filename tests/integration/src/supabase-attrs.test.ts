import type { Principal } from 'permdock';
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

import { permissions } from '../fixtures/abac/permissions.ts';
import { policy } from '../fixtures/abac/policy.ts';
import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/supabase-attrs');

const EU = '00000000-0000-4000-8000-0000000000b1';
const US = '00000000-0000-4000-8000-0000000000b2';
const BIG = '00000000-0000-4000-8000-0000000000b3';
const NONE = '00000000-0000-4000-8000-0000000000b4';
const USERS = [EU, US, BIG, NONE];

const REPORTS = [
  { id: 'r_eu_1', region: 'eu', clearance: 1 },
  { id: 'r_eu_3', region: 'eu', clearance: 3 },
  { id: 'r_us_1', region: 'us', clearance: 1 },
];
const TICKETS = [
  { id: 't_eu', region: 'eu' },
  { id: 't_uk', region: 'uk' },
  { id: 't_us', region: 'us' },
];

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
grant authenticated, anon, supabase_auth_admin to tester;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon, supabase_auth_admin;
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
grant select on auth.users to supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ${USERS.map((id) => `('${id}')`).join(', ')};
update auth.users set raw_app_meta_data = '{"regions": ["eu", "uk"], "user_note": "x"}' where id = '${EU}';
update auth.users set raw_app_meta_data = '{"regions": ["us"]}' where id = '${US}';
create table memberships (user_id uuid not null, scope text not null, scope_id text not null, role text not null);
create table profiles (id uuid primary key, region text, clearance integer, bio text);
insert into profiles values
  ('${EU}', 'eu', 2, 'hello'),
  ('${US}', 'us', 1, null),
  ('${BIG}', '${'x'.repeat(1500)}', 5, null);
grant select on profiles to authenticated;
grant update (bio) on profiles to authenticated;
create table report (id text primary key, region text not null, clearance integer not null);
create table ticket (id text primary key, region text not null);
create table record (id text primary key, region text not null);
insert into report values ${REPORTS.map((row) => `('${row.id}', '${row.region}', ${String(row.clearance)})`).join(', ')};
insert into ticket values ${TICKETS.map((row) => `('${row.id}', '${row.region}')`).join(', ')};
grant select on report, ticket, record to authenticated;
`;

type Claims = Record<string, unknown>;

async function generate(args: readonly string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'permdock-attrs-'));
  const out = join(dir, 'out.sql');
  const result = await run([...args, '--out', out], { cwd: FIXTURE });
  if (result.code !== 0) {
    throw new Error(`${args.join(' ')}: ${result.stdout}${result.stderr}`);
  }
  const sql = readFileSync(out, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return sql;
}

describe('the attrs claim against Postgres', () => {
  let db: Postgres | undefined;
  let hook = '';

  beforeAll(async () => {
    hook = await generate(['supabase', 'hook', 'generate']);
    const rls = await generate(['rls', 'generate', '--target', 'sql']);
    db = await startPostgres([SETUP, hook, rls]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  function as<T>(
    dbRole: 'authenticated' | 'supabase_auth_admin',
    claims: Claims,
    work: (client: Client) => Promise<T>,
  ): Promise<T> {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const client = db.tester;
    return db.as(
      {
        role: dbRole,
        settings: { 'request.jwt.claims': JSON.stringify(claims) },
      },
      () => work(client),
    );
  }

  async function mint(user: string): Promise<Claims> {
    return as('supabase_auth_admin', {}, async (client) => {
      const result = await client.query<{ event: { claims: Claims } }>(
        'select public.custom_access_token_hook($1::jsonb) as event',
        [
          JSON.stringify({
            user_id: user,
            claims: {
              sub: user,
              role: 'authenticated',
              attrs: { region: 'forged' },
            },
          }),
        ],
      );
      const claims = result.rows[0]?.event.claims;
      if (claims === undefined) {
        throw new Error('PermDock: the hook returned no claims');
      }
      return claims;
    });
  }

  it('writes allow-listed columns and app_metadata keys, nothing else', async () => {
    expect((await mint(EU))['attrs']).toEqual({
      region: 'eu',
      clearance: 2,
      regions: ['eu', 'uk'],
    });
    expect((await mint(US))['attrs']).toEqual({
      region: 'us',
      clearance: 1,
      regions: ['us'],
    });
    const none = await mint(NONE);
    expect(none).not.toHaveProperty('attrs');
    expect(none).not.toHaveProperty('memberships_truncated');
  });

  it('counts attrs in the budget and drops them with the truncation flag', async () => {
    const claims = await mint(BIG);
    expect(claims).not.toHaveProperty('attrs');
    expect(claims['memberships_truncated']).toBe(true);
  });

  it('agrees with can() on nested attribute conditions for the minted claims', async () => {
    for (const user of USERS) {
      const claims = await mint(user);
      // SAFETY: minted claims always carry a subject, so the principal is set
      const principal = subjectFromSupabase(claims).principal as Principal;
      const dock = await createPermDock(policy, principal);
      for (const [permission, table, rows] of [
        [permissions.report.read, 'report', REPORTS],
        [permissions.ticket.read, 'ticket', TICKETS],
      ] as const) {
        // SAFETY: every seeded row has an id and matches the resource its permission checks
        const expected = (rows as readonly { readonly id: string }[])
          .filter((row) => dock.can(permission, row as never))
          .map((row) => row.id)
          .toSorted();
        const actual = await as('authenticated', claims, async (client) =>
          (
            await client.query<{ id: string }>(
              `select id from public.${table} order by id`,
            )
          ).rows.map((row) => row.id),
        );
        expect({ user, table, rows: actual.toSorted() }).toEqual({
          user,
          table,
          rows: expected,
        });
      }
    }
    const eu = await mint(EU);
    const reports = await as(
      'authenticated',
      eu,
      async (client) =>
        (await client.query<{ id: string }>('select id from public.report'))
          .rows,
    );
    expect(reports).toEqual([{ id: 'r_eu_1' }]);
  });

  it('refuses to install while clients can write an attrs column', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    await db.admin.query('grant update (region) on profiles to authenticated');
    try {
      await expect(db.admin.query(hook)).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await db.admin.query(
        'revoke update (region) on profiles from authenticated',
      );
    }
    await expect(db.admin.query(hook)).resolves.toBeDefined();
  });
});
