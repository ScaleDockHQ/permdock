import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'permdock/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/supabase-sources');

const OWNER = '00000000-0000-4000-8000-0000000000b1';
const CONTACT = '00000000-0000-4000-8000-0000000000b2';
const SUSPENDED = '00000000-0000-4000-8000-0000000000b3';
const USERS = [OWNER, CONTACT, SUSPENDED];

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
grant execute on all functions in schema auth to authenticated, anon;
grant select on auth.users to supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ${USERS.map((id) => `('${id}')`).join(', ')};
create table memberships (
  user_id uuid not null, scope text not null, scope_id text not null, role text not null,
  via text, expires_at timestamptz, managed_by text, seats text[]
);
insert into memberships values
  ('${OWNER}', 'organization', 'T', 'owner', 'staff', null, null, null),
  ('${OWNER}', 'organization', 'B', 'member', 'staff', '2100-01-01T00:00:00Z', null, null),
  ('${OWNER}', 'organization', 'X', 'owner', 'staff', null, null, null),
  ('${CONTACT}', 'organization', 'T', 'member', 'staff', now() - interval '1 day', null, null),
  ('${SUSPENDED}', 'organization', 'T', 'admin', 'staff', null, null, null);
create table customer_contacts (customer_id text not null, organization_id text not null, user_id uuid not null);
insert into customer_contacts values ('A', 'T', '${CONTACT}');
create table user_roles (user_id uuid not null, role text not null);
create table profiles (id uuid primary key, locale text, timezone text, disabled_at timestamptz);
insert into profiles select id, null, null, null from auth.users;
update profiles set disabled_at = now() where id = '${SUSPENDED}';
create table organization (id text primary key, disabled_at timestamptz);
insert into organization values ('T', null), ('B', null), ('X', now());
create schema pd_db;
grant usage on schema pd_db to authenticated;
`;

/** The extra claim better-supabase owns: one entry per organization the user is a member of. */
const FEATURE_CLAIMS = `
create schema better_supabase;
create function better_supabase.feature_claims(uid uuid) returns jsonb language sql stable as $$
  select jsonb_object_agg(id, jsonb_build_array('export') order by id)
  from public.member_organization_ids_for(uid) id
$$;
`;

async function generate(
  args: readonly string[],
  files: readonly string[],
): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'permdock-member-for-'));
  const placed = args.map((arg) => arg.replaceAll('{dir}', dir));
  try {
    const result = await run(placed, { cwd: FIXTURE });
    if (result.code !== 0) {
      throw new Error(`${args.join(' ')}: ${result.stdout}${result.stderr}`);
    }
    return files.map((file) => readFileSync(join(dir, file), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('member_<scope>_ids_for against Postgres', () => {
  let db: Postgres | undefined;

  const rls = (authorize: string, schema: string): Promise<string[]> =>
    generate(
      [
        'rls',
        'generate',
        '--target',
        'sql',
        '--rbac',
        'supabase',
        '--authorize',
        authorize,
        '--rbac-schema',
        schema,
        '--tenant-type',
        'text',
        '--split',
        'helpers,policies',
        '--out',
        '{dir}/{part}.sql',
      ],
      ['helpers.sql'],
    );

  beforeAll(async () => {
    const [jwt, database, hook] = await Promise.all([
      rls('jwt', 'public'),
      rls('database', 'pd_db'),
      generate(
        [
          'supabase',
          'hook',
          'generate',
          '--out',
          '{dir}/hook.sql',
          '--grants-out',
          '{dir}/grants.sql',
        ],
        ['hook.sql', 'grants.sql'],
      ),
    ]);
    db = await startPostgres([
      SETUP,
      ...jwt,
      ...database,
      FEATURE_CLAIMS,
      ...hook,
      'grant usage on schema pd_db to supabase_auth_admin',
      'grant execute on function pd_db.member_organization_ids_for(uuid) to supabase_auth_admin',
    ]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  function idsFor(
    dbRole: 'authenticated' | 'supabase_auth_admin',
    fn: string,
    user: string,
  ): Promise<string[]> {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const tester = db.tester;
    return db.as({ role: dbRole }, async () =>
      (
        await tester.query<{ id: string }>(
          `select id from ${fn}($1::uuid) id order by id`,
          [user],
        )
      ).rows.map((row) => row.id),
    );
  }

  it('reads the sources as supabase_auth_admin with no request.jwt.claims', async () => {
    const fn = 'public.member_organization_ids_for';
    expect(await idsFor('supabase_auth_admin', fn, OWNER)).toEqual(['B', 'T']);
    expect(await idsFor('supabase_auth_admin', fn, CONTACT)).toEqual([]);
    expect(await idsFor('supabase_auth_admin', fn, SUSPENDED)).toEqual([]);
    expect(
      await idsFor(
        'supabase_auth_admin',
        'public.member_customer_ids_for',
        CONTACT,
      ),
    ).toEqual(['A']);
  });

  it('agrees with member_<scope>_ids() in database mode', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const tester = db.tester;
    for (const user of USERS) {
      const own = await db.as(
        {
          role: 'authenticated',
          settings: {
            'request.jwt.claims': JSON.stringify({
              sub: user,
              role: 'authenticated',
            }),
          },
        },
        async () =>
          (
            await tester.query<{ id: string }>(
              'select id from pd_db.member_organization_ids() id order by id',
            )
          ).rows.map((row) => row.id),
      );
      expect(
        await idsFor(
          'supabase_auth_admin',
          'pd_db.member_organization_ids_for',
          user,
        ),
      ).toEqual(own);
      expect(
        await idsFor(
          'supabase_auth_admin',
          'public.member_organization_ids_for',
          user,
        ),
      ).toEqual(own);
    }
  });

  it('feeds a hook.claims function inside the token hook', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const tester = db.tester;
    const mint = (user: string): Promise<Record<string, unknown>> =>
      db?.as({ role: 'supabase_auth_admin' }, async () => {
        const result = await tester.query<{
          event: { claims: Record<string, unknown> };
        }>('select public.custom_access_token_hook($1::jsonb) as event', [
          JSON.stringify({
            user_id: user,
            claims: { sub: user, role: 'authenticated' },
          }),
        ]);
        return result.rows[0]?.event.claims ?? {};
      }) ?? Promise.resolve({});
    expect((await mint(OWNER))['features']).toEqual({
      B: ['export'],
      T: ['export'],
    });
    expect(await mint(CONTACT)).not.toHaveProperty('features');
  });

  it('denies authenticated and anon', async () => {
    for (const dbRole of ['authenticated', 'anon'] as const) {
      if (db === undefined) {
        throw new Error('PermDock: Postgres was not started');
      }
      const tester = db.tester;
      await expect(
        db.as({ role: dbRole }, () =>
          tester.query('select public.member_organization_ids_for($1::uuid)', [
            OWNER,
          ]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });
});
