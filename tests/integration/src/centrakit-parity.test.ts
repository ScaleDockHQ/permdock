import type { Membership } from 'permdock';
import type { SqlQuery } from 'permdock/supabase';
import type { Client } from 'pg';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeMemberships } from 'permdock';
import { run } from 'permdock/cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { sources } from '../fixtures/centrakit/sources.ts';
import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/centrakit');

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const PLATFORM = id(0xa1);
const OWNER = id(0xa2);
const ADMIN = id(0xa3);
const MEMBER = id(0xa4);
const VIEWER = id(0xa5);
const CONTACT = id(0xa6);
const MIXED = id(0xa7);
const SUSPENDED = id(0xa8);
const LATE = id(0xa9);
const USERS = [
  PLATFORM,
  OWNER,
  ADMIN,
  MEMBER,
  VIEWER,
  CONTACT,
  MIXED,
  SUSPENDED,
  LATE,
];

const ORG_A = id(0xb1);
const ORG_B = id(0xb2);
const ORG_OFF = id(0xb3);
const CUST_A1 = id(0xc1);
const CUST_A2 = id(0xc2);
const CUST_B1 = id(0xc3);
const CUST_OFF = id(0xc4);
const OPEN_CONTACT = id(0xd1);

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
insert into auth.users (id) values ${USERS.map((user) => `('${user}')`).join(', ')};
create table organizations (id uuid primary key, slug text not null, disabled_at timestamptz);
insert into organizations values
  ('${ORG_A}', 'acme', null), ('${ORG_B}', 'bolt', null), ('${ORG_OFF}', 'gone', now());
create table profiles (
  user_id uuid primary key, active_organization_id uuid, disabled_at timestamptz,
  timezone text, week_start int, date_format text, time_format text
);
insert into profiles (user_id) select id from auth.users;
update profiles set active_organization_id = '${ORG_A}' where user_id = '${OWNER}';
update profiles set active_organization_id = '${ORG_B}' where user_id = '${MIXED}';
update profiles set disabled_at = now() where user_id = '${SUSPENDED}';
create table memberships (
  user_id uuid not null, scope text not null, scope_id uuid not null, role text not null,
  via text, expires_at timestamptz
);
insert into memberships values
  ('${OWNER}', 'organization', '${ORG_A}', 'owner', 'staff', null),
  ('${OWNER}', 'organization', '${ORG_OFF}', 'owner', 'staff', null),
  ('${ADMIN}', 'organization', '${ORG_A}', 'admin', 'staff', null),
  ('${MEMBER}', 'organization', '${ORG_A}', 'member', 'staff', '2100-01-01T00:00:00Z'),
  ('${VIEWER}', 'organization', '${ORG_A}', 'viewer', 'staff', null),
  ('${VIEWER}', 'organization', '${ORG_B}', 'member', 'staff', now() - interval '1 day'),
  ('${MIXED}', 'organization', '${ORG_B}', 'member', 'staff', null),
  ('${SUSPENDED}', 'organization', '${ORG_A}', 'admin', 'staff', null);
create table contacts (
  id uuid primary key, organization_id uuid not null, customer_id uuid not null, user_id uuid,
  name text
);
insert into contacts values
  ('${id(0xd2)}', '${ORG_A}', '${CUST_A1}', '${CONTACT}', 'Private'),
  ('${id(0xd3)}', '${ORG_A}', '${CUST_A2}', '${MIXED}', 'Mixed'),
  ('${OPEN_CONTACT}', '${ORG_B}', '${CUST_B1}', null, 'No login yet'),
  ('${id(0xd4)}', '${ORG_OFF}', '${CUST_OFF}', '${CONTACT}', 'Gone');
create table user_roles (user_id uuid not null, role text not null);
insert into user_roles values ('${PLATFORM}', 'platform-admin'), ('${SUSPENDED}', 'platform-admin');
create table customers (id uuid primary key, organization_id uuid not null);
create table quotes (id uuid primary key, organization_id uuid not null, customer_id uuid not null);
grant select on customers, quotes to authenticated;
`;

type Claims = Record<string, unknown>;

const SCOPES = ['organization', 'customer'] as const;

function byScope(list: readonly Membership[]): Membership[] {
  return list.toSorted((a, b) =>
    `${a.scope}:${a.id}`.localeCompare(`${b.scope}:${b.id}`),
  );
}

const sorted = (ids: Iterable<string | undefined>): string[] =>
  [...new Set(ids)]
    .filter((value): value is string => value !== undefined)
    .toSorted();

describe('CentraKit: hook claim, composeMemberships and the RLS helpers agree', () => {
  let db: Postgres | undefined;
  let query: SqlQuery = async () => [];
  /** `[role, grant, scope]` from the generated `role_permissions`. */
  let grants: readonly (readonly [string, string, string])[] = [];

  async function generate(args: readonly string[]): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'permdock-centrakit-'));
    const out = join(dir, 'out.sql');
    try {
      const result = await run([...args, '--out', out], { cwd: FIXTURE });
      if (result.code !== 0) {
        throw new Error(`${args.join(' ')}: ${result.stdout}${result.stderr}`);
      }
      return readFileSync(out, 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  beforeAll(async () => {
    const hook = await generate(['supabase', 'hook', 'generate']);
    const database = await generate([
      'rls',
      'generate',
      '--target',
      'sql',
      '--rbac',
      'supabase',
    ]);
    const jwt = await generate([
      'rls',
      'generate',
      '--target',
      'sql',
      '--rbac',
      'supabase',
      '--authorize',
      'jwt',
      '--rbac-schema',
      'pd_jwt',
    ]);
    db = await startPostgres([
      SETUP,
      database,
      'create schema pd_jwt; grant usage on schema pd_jwt to authenticated',
      jwt,
      hook,
    ]);
    const admin = db.admin;
    query = async (text, values) => (await admin.query(text, [...values])).rows;
    grants = (
      await admin.query<{ role: string; grant_key: string; scope: string }>(
        'select role, grant_key, scope from public.role_permissions',
      )
    ).rows.map((row) => [row.role, row.grant_key, row.scope] as const);
  }, 180_000);

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
            claims: { sub: user, role: 'authenticated' },
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

  // SAFETY: the custom access token hook mints memberships as Membership objects
  const membershipsOf = (claims: Claims) =>
    claims['memberships'] as Membership[];

  /** What `permitted_<scope>_ids(grant)` must return for these memberships, narrowed to the active organization. */
  function expected(
    memberships: readonly Membership[],
    grant: string,
    scope: string,
    tenant: unknown,
  ): string[] {
    const kinds: Readonly<Record<string, string>> = {
      owner: 'staff',
      admin: 'staff',
      member: 'staff',
      viewer: 'staff',
      contact: 'contact',
    };
    return sorted(
      memberships
        .filter((m) => m.scope === scope)
        .filter(
          (m) =>
            typeof tenant !== 'string' ||
            (m.scope === 'organization' ? m.id : m.within?.['organization']) ===
              tenant,
        )
        .filter((m) =>
          m.roles.some(
            (name) =>
              kinds[name] === m.via &&
              grants.some(
                ([r, g, s]) => r === name && g === grant && s === scope,
              ),
          ),
        )
        .map((m) => m.id),
    );
  }

  /** The helpers' answers the minted claims imply. */
  function want(claims: Claims) {
    const memberships = membershipsOf(claims);
    // SAFETY: the custom access token hook mints roles as a string array
    const roles = claims['roles'] as string[];
    const member: Record<string, string[]> = {};
    const permitted: Record<string, string[]> = {};
    const has: Record<string, boolean> = {};
    for (const scope of SCOPES) {
      member[scope] = sorted(
        memberships.filter((m) => m.scope === scope).map((m) => m.id),
      );
    }
    for (const [, grant, scope] of grants) {
      if (scope === 'global') {
        has[grant] = grants.some(
          ([r, g, s]) => s === 'global' && g === grant && roles.includes(r),
        );
      } else {
        permitted[`${scope}:${grant}`] = expected(
          memberships,
          grant,
          scope,
          claims['tenant_id'],
        );
      }
    }
    return { permitted, member, has };
  }

  async function helpers(
    schema: 'public' | 'pd_jwt',
    claims: Claims,
  ): Promise<{
    readonly permitted: Readonly<Record<string, string[]>>;
    readonly member: Readonly<Record<string, string[]>>;
    readonly has: Readonly<Record<string, boolean>>;
  }> {
    return as('authenticated', claims, async (client) => {
      const permitted: Record<string, string[]> = {};
      const member: Record<string, string[]> = {};
      const has: Record<string, boolean> = {};
      for (const scope of SCOPES) {
        member[scope] = sorted(
          (
            await client.query<{ id: string }>(
              `select id::text from ${schema}.member_${scope}_ids() id`,
            )
          ).rows.map((row) => row.id),
        );
        for (const [, grant, s] of grants) {
          if (s !== scope) continue;
          permitted[`${scope}:${grant}`] = sorted(
            (
              await client.query<{ id: string }>(
                `select id::text from ${schema}.permitted_${scope}_ids($1) id`,
                [grant],
              )
            ).rows.map((row) => row.id),
          );
        }
      }
      for (const [, grant, s] of grants) {
        if (s !== 'global') continue;
        has[grant] =
          (
            await client.query<{ ok: boolean }>(
              `select ${schema}.permdock_has($1) ok`,
              [grant],
            )
          ).rows[0]?.ok ?? false;
      }
      return { permitted, member, has };
    });
  }

  it('mints the claim CentraKit expects for every principal', async () => {
    expect(membershipsOf(await mint(OWNER))).toEqual([
      { scope: 'organization', id: ORG_A, roles: ['owner'], via: 'staff' },
    ]);
    expect((await mint(OWNER))['tenant_id']).toBe(ORG_A);
    expect(membershipsOf(await mint(CONTACT))).toEqual([
      {
        scope: 'customer',
        id: CUST_A1,
        within: { organization: ORG_A },
        roles: ['contact'],
        via: 'contact',
      },
    ]);
    expect(
      byScope(membershipsOf(await mint(MIXED))).map((m) => [m.scope, m.id]),
    ).toEqual([
      ['customer', CUST_A2],
      ['organization', ORG_B],
    ]);
    expect(membershipsOf(await mint(VIEWER))).toEqual([
      { scope: 'organization', id: ORG_A, roles: ['viewer'], via: 'staff' },
    ]);
    const platform = await mint(PLATFORM);
    expect(platform['roles']).toEqual(['platform-admin']);
    expect(platform['memberships']).toEqual([]);
    expect(await mint(SUSPENDED)).toMatchObject({
      roles: [],
      memberships: [],
    });
    expect(membershipsOf(await mint(LATE))).toEqual([]);
  });

  it('resolves the same memberships through composeMemberships', async () => {
    const composed = composeMemberships(sources(query));
    for (const user of USERS) {
      const live = await composed.membershipsFor({ id: user }, {});
      expect({ user, memberships: byScope(live) }).toEqual({
        user,
        memberships: byScope(membershipsOf(await mint(user))),
      });
    }
  });

  it('returns from the database-mode and jwt-mode helpers what the claim grants', async () => {
    const mixed = await helpers('public', {
      sub: MIXED,
      role: 'authenticated',
    });
    expect(mixed.member).toEqual({
      organization: [ORG_B],
      customer: [CUST_A2],
    });
    const views = grants.find(
      ([r, g]) => r === 'contact' && g.startsWith('quotes.read'),
    );
    expect(views).toBeDefined();
    expect(mixed.permitted[`customer:${views?.[1] ?? ''}`]).toEqual([CUST_A2]);
    const platform = await helpers('pd_jwt', await mint(PLATFORM));
    expect(Object.values(platform.has)).toContain(true);
    for (const user of USERS) {
      const claims = await mint(user);
      for (const schema of ['public', 'pd_jwt'] as const) {
        expect({ schema, user, ...(await helpers(schema, claims)) }).toEqual({
          schema,
          user,
          ...want(claims),
        });
      }
    }
  });

  it('bumps authz_ver when a contact gets a login and loses it', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const admin = db.admin;
    const version = async () =>
      Number(
        (
          await admin.query<{ version: string }>(
            'select version from public.permdock_authz_version where user_id = $1',
            [LATE],
          )
        ).rows[0]?.version ?? 0,
      );
    const before = await version();
    await admin.query('update contacts set user_id = $1 where id = $2', [
      LATE,
      OPEN_CONTACT,
    ]);
    const linked = await version();
    expect(linked).toBeGreaterThan(before);
    expect(membershipsOf(await mint(LATE))).toEqual([
      {
        scope: 'customer',
        id: CUST_B1,
        within: { organization: ORG_B },
        roles: ['contact'],
        via: 'contact',
      },
    ]);
    await admin.query('update contacts set user_id = null where id = $1', [
      OPEN_CONTACT,
    ]);
    expect(await version()).toBeGreaterThan(linked);
    expect(membershipsOf(await mint(LATE))).toEqual([]);
  });
});
