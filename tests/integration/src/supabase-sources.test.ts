import type { Membership, Principal } from 'permdock';
import type { Client } from 'pg';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allow,
  claimsFirst,
  composeMemberships,
  createPermDock,
  definePolicy,
  plan,
  role,
} from 'permdock';
import { run } from 'permdock/cli';
import {
  authzVersion,
  subjectFromSupabase,
  type SqlQuery,
} from 'permdock/supabase';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Postgres } from './support/postgres.ts';

import { permissions, roles } from '../fixtures/named-scopes/policy.ts';
import { sources } from '../fixtures/supabase-sources/sources.ts';
import { startPostgres } from './support/postgres.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '../fixtures/supabase-sources');

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const CONTACT = '00000000-0000-4000-8000-0000000000a2';
const SEATED = '00000000-0000-4000-8000-0000000000a3';
const BIG = '00000000-0000-4000-8000-0000000000a4';
const ADMIN = '00000000-0000-4000-8000-0000000000a5';
const SUSPENDED = '00000000-0000-4000-8000-0000000000a6';
const USERS = [OWNER, CONTACT, SEATED, BIG, ADMIN, SUSPENDED];
const MANY = Array.from(
  { length: 40 },
  (_, index) => `O${String(index).padStart(2, '0')}`,
);

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
grant authenticated, anon, supabase_auth_admin to tester;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
grant usage on schema auth to supabase_auth_admin;
grant select on auth.users to supabase_auth_admin;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ${USERS.map((id) => `('${id}')`).join(', ')};
update auth.users set raw_app_meta_data = '{"active_organization": "B"}' where id = '${OWNER}';
update auth.users set raw_app_meta_data = '{"active_organization": "O39"}' where id = '${BIG}';
create table memberships (
  user_id uuid not null, scope text not null, scope_id text not null, role text not null,
  via text, expires_at timestamptz, managed_by text, seats text[]
);
insert into memberships values
  ('${OWNER}', 'organization', 'T', 'owner', 'staff', null, null, null),
  ('${OWNER}', 'organization', 'B', 'member', 'staff', null, 'idp', null),
  ('${OWNER}', 'organization', 'X', 'owner', 'staff', null, null, null),
  ('${CONTACT}', 'organization', 'T', 'member', 'staff', now() - interval '1 day', null, null),
  ('${SEATED}', 'organization', 'T', 'member', 'staff', '2100-01-01T00:00:00Z', null, '{dev-mode}'),
  ('${SUSPENDED}', 'organization', 'T', 'admin', 'staff', null, null, null);
insert into memberships select '${BIG}', 'organization', o, 'viewer', 'staff', null, null, null
  from unnest(array[${MANY.map((id) => `'${id}'`).join(', ')}]) o;
create table customer_contacts (customer_id text not null, organization_id text not null, user_id uuid not null);
insert into customer_contacts values ('A', 'T', '${CONTACT}'), ('C', 'X', '${CONTACT}');
create table user_roles (user_id uuid not null, role text not null);
insert into user_roles values ('${ADMIN}', 'platform-admin'), ('${SUSPENDED}', 'platform-support');
create table profiles (id uuid primary key, locale text, timezone text, secret text, disabled_at timestamptz);
insert into profiles select id, 'nl-NL', 'Europe/Amsterdam', 'never-copied', null from auth.users;
update profiles set disabled_at = now() where id = '${SUSPENDED}';
create table organization (id text primary key, disabled_at timestamptz);
insert into organization select o, null from unnest(array['T', 'B', ${MANY.map((id) => `'${id}'`).join(', ')}]) o;
insert into organization values ('X', now());
grant select, insert, update, delete on memberships to authenticated;
`;

type Claims = Record<string, unknown>;

const byJson = (list: readonly unknown[]): unknown[] =>
  list
    .map((item) => JSON.stringify(item, Object.keys(item as object).toSorted()))
    .toSorted()
    .map((text) => JSON.parse(text) as unknown);

describe('permdock supabase hook generate against Postgres', () => {
  let db: Postgres | undefined;
  let generated = '';
  let query: SqlQuery = async () => [];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'permdock-sources-'));
    const out = join(dir, 'hook.sql');
    const result = await run(['supabase', 'hook', 'generate', '--out', out], {
      cwd: FIXTURE,
    });
    if (result.code !== 0) {
      throw new Error(`hook generate: ${result.stdout}${result.stderr}`);
    }
    generated = readFileSync(out, 'utf8');
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([SETUP, generated]);
    const admin = db.admin;
    query = async (text, values) => (await admin.query(text, [...values])).rows;
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

  it('writes roles, memberships with via, expiry, owner and seats, attrs and the active tenant', async () => {
    const owner = await mint(OWNER);
    expect(owner['memberships']).toEqual([
      {
        scope: 'organization',
        id: 'B',
        roles: ['member'],
        via: 'staff',
        managedBy: 'idp',
      },
      { scope: 'organization', id: 'T', roles: ['owner'], via: 'staff' },
    ]);
    expect(owner['tenant_id']).toBe('B');
    expect(owner['attrs']).toEqual({
      locale: 'nl-NL',
      timezone: 'Europe/Amsterdam',
    });
    expect(owner['roles']).toEqual([]);
    expect(owner['authz_ver']).toBeTypeOf('number');
    expect(owner).not.toHaveProperty('memberships_truncated');
    expect((await mint(CONTACT))['memberships']).toEqual([
      {
        scope: 'customer',
        id: 'A',
        within: { organization: 'T' },
        roles: ['contact'],
        via: 'contact',
      },
    ]);
    const seated = await mint(SEATED);
    expect(seated['memberships']).toEqual([
      {
        scope: 'organization',
        id: 'T',
        roles: ['member'],
        via: 'staff',
        expiresAt: 4102444800,
        entitlements: ['dev-mode'],
      },
    ]);
    expect(seated).not.toHaveProperty('tenant_id');
    const admin = await mint(ADMIN);
    expect(admin['user_role']).toBe('platform-admin');
    expect(admin['roles']).toEqual(['platform-admin']);
  });

  it('empties the claims of a suspended user', async () => {
    const claims = await mint(SUSPENDED);
    expect(claims).toMatchObject({ user_role: [], roles: [], memberships: [] });
  });

  it('resolves the same memberships at runtime as the hook writes', async () => {
    const composed = composeMemberships(sources(query));
    for (const user of [OWNER, CONTACT, SEATED]) {
      const claims = await mint(user);
      const live = await composed.membershipsFor({ id: user }, {});
      expect(byJson(live)).toEqual(byJson(claims['memberships'] as unknown[]));
    }
  });

  it('puts the active scope first, truncates at the budget and falls back to the source', async () => {
    const claims = await mint(BIG);
    const kept = claims['memberships'] as Membership[];
    expect(claims['memberships_truncated']).toBe(true);
    expect(kept.length).toBeLessThan(MANY.length);
    expect(kept[0]?.id).toBe('O39');
    expect(claims['tenant_id']).toBe('O39');
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(1024);
    const principal = subjectFromSupabase(claims).principal as Principal;
    expect(principal.membershipsTruncated).toBe(true);
    const policy = definePolicy(
      { permissions, roles },
      {
        scopes: {
          organization: { key: 'organization_id' },
          customer: { key: 'customer_id', within: 'organization' },
        },
        roles: [
          role(roles.viewer, [allow(permissions.quote.read)], {
            on: 'organization',
          }),
        ],
        subject: (user: Principal | null) => user,
      },
    );
    const dock = await createPermDock(policy, principal, {
      memberships: claimsFirst(sources(query)),
      tenant: 'O00',
    });
    expect(dock.subject.principal?.memberships).toHaveLength(MANY.length);
    expect(
      dock.can(permissions.quote.read, {
        id: 'q',
        organization_id: 'O00',
        customer_id: 'c',
        status: 'sent',
      }),
    ).toBe(true);
  });

  it('bumps authz_ver on membership changes and denies fresh permissions on an older token', async () => {
    if (db === undefined) {
      throw new Error('PermDock: Postgres was not started');
    }
    const policy = definePolicy(
      { permissions, roles },
      {
        scopes: {
          organization: { key: 'organization_id' },
          customer: { key: 'customer_id', within: 'organization' },
        },
        roles: [
          role(
            roles.owner,
            [allow([permissions.quote.read, permissions.quote.delete])],
            {
              on: 'organization',
            },
          ),
        ],
        grants: [
          allow(permissions.organization.list, { to: plan('dev-mode') }),
        ],
        fresh: [permissions.quote.delete],
        subject: (user: Principal | null) => user,
      },
    );
    const quote = {
      id: 'q',
      organization_id: 'T',
      customer_id: 'c',
      status: 'sent',
    };
    const memberships = claimsFirst(sources(query), {
      version: authzVersion({ query }),
    });
    const before = await mint(OWNER);
    const dockFor = async (claims: Claims) =>
      createPermDock(
        policy,
        subjectFromSupabase({ ...claims, tenant_id: 'T' })
          .principal as Principal,
        { memberships },
      );
    expect((await dockFor(before)).can(permissions.quote.delete, quote)).toBe(
      true,
    );
    await db.admin.query(
      `update memberships set via = 'staff' where user_id = '${OWNER}' and scope_id = 'T'`,
    );
    const stale = await dockFor(before);
    expect(stale.decide(permissions.quote.delete, quote).denials).toEqual([
      { role: null, reason: 'stale-credentials' },
    ]);
    expect(stale.can(permissions.quote.read, quote)).toBe(true);
    const after = await mint(OWNER);
    expect(after['authz_ver']).toBeGreaterThan(before['authz_ver'] as number);
    expect((await dockFor(after)).can(permissions.quote.delete, quote)).toBe(
      true,
    );
    const seated = await createPermDock(
      policy,
      subjectFromSupabase({ ...(await mint(SEATED)), tenant_id: 'T' })
        .principal as Principal,
      { memberships },
    );
    expect(seated.can(permissions.organization.list)).toBe(true);
  });

  it('lists the members of a scope instance', async () => {
    const composed = composeMemberships(sources(query));
    const members = await composed.list?.({ scope: 'organization', id: 'T' });
    expect(members?.map((entry) => entry.principal.id).toSorted()).toEqual(
      [OWNER, SEATED].toSorted(),
    );
    const contacts = await composed.list?.({ scope: 'customer', id: 'A' });
    expect(contacts).toEqual([
      {
        principal: { id: CONTACT },
        membership: {
          scope: 'customer',
          id: 'A',
          within: { organization: 'T' },
          roles: ['contact'],
          via: 'contact',
        },
      },
    ]);
  });

  it('refuses client writes to memberships the identity provider owns', async () => {
    const claims = { sub: OWNER, role: 'authenticated' };
    await expect(
      as('authenticated', claims, (client) =>
        client.query(
          `update public.memberships set role = 'owner' where scope_id = 'B'`,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      as('authenticated', claims, (client) =>
        client.query(`delete from public.memberships where scope_id = 'B'`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const changed = await as(
      'authenticated',
      claims,
      async (client) =>
        (
          await client.query(
            `update public.memberships set role = 'owner' where scope_id = 'X'`,
          )
        ).rowCount,
    );
    expect(changed).toBe(1);
    expect(generated).not.toMatch(/service_role/iu);
  });
});
