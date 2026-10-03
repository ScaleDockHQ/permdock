import { describe, expect, it } from 'vitest';

import type { SqlQuery } from '../../src/supabase/sources.ts';

import {
  authzVersion,
  fromJunction,
  fromTable,
} from '../../src/supabase/sources.ts';

type Call = { readonly text: string; readonly values: readonly unknown[] };

function recording(
  rows: readonly Record<string, unknown>[],
  shape: 'array' | 'result' = 'result',
): { readonly query: SqlQuery; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    query: async (text, values) => {
      calls.push({ text, values });
      return shape === 'array' ? rows : { rows };
    },
  };
}

const principal = { id: 'u1', roles: [] };

describe('fromTable', () => {
  it('selects one row per instance with the default columns', () => {
    const { sql } = fromTable({ table: 'memberships' });
    expect(sql.table).toBe('memberships');
    expect(sql.user).toBe('user_id');
    expect(sql.columns).toEqual(['user_id', 'scope', 'scope_id', 'role']);
    expect(sql.reads).toEqual([]);
    expect(sql.select('$1'))
      .toBe(`select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
from "public"."memberships" m
where m."user_id" = $1
group by m."scope"::text, m."scope_id"::text`);
    expect(sql.list()).toContain(
      'where m."scope"::text = $1::text and m."scope_id"::text = $2::text',
    );
    expect(sql.list()).toMatch(/^select m."user_id"::text as user_id, /u);
    expect(sql.manifest).toEqual({
      table: 'public.memberships',
      user: { column: 'user_id' },
      scope: { column: 'scope' },
      id: { column: 'scope_id' },
      role: { column: 'role' },
      columns: ['user_id', 'scope', 'scope_id', 'role'],
    });
  });

  it('maps every optional column and applies expiry and suspension filters', () => {
    const { sql } = fromTable({
      table: 'auth_ext.members',
      columns: {
        user: 'uid',
        scope: 'kind',
        id: 'ref',
        within: 'parents',
        role: 'role_name',
        via: 'source',
        expiresAt: 'ends_at',
        grantedBy: 'granted_by',
        reason: 'why',
        group: 'squad',
        managedBy: 'owner',
        seats: 'seats',
      },
      suspension: {
        users: { table: 'profiles', id: 'id', disabledAt: 'banned_at' },
        scopes: {
          tenant: {
            table: 'orgs',
            id: 'id',
            status: 'state',
            active: ['active', "o'k"],
          },
        },
      },
    });
    const select = sql.select('$1');
    expect(select).toContain('from "auth_ext"."members" m');
    expect(select).toContain('m."parents" as within');
    expect(select).toContain(
      'floor(extract(epoch from m."ends_at"))::bigint as expires_at',
    );
    expect(select).toContain('to_jsonb(m."seats") as seats');
    expect(select).toContain('(m."ends_at" is null or m."ends_at" > now())');
    expect(select).toContain(
      'exists (select 1 from "public"."profiles" s where s."id"::text = (m."uid")::text and s."banned_at" is null)',
    );
    expect(select).toContain(
      `s."state"::text = any(array['active', 'o''k']::text[])`,
    );
    expect(select).toContain(
      `coalesce(case when m."kind"::text = 'tenant' then m."ref"::text end, m."parents" ->> 'tenant')`,
    );
    expect(sql.reads).toEqual(['profiles', 'orgs']);
    expect(sql.managed).toBe('owner');
    expect(sql.columns).toEqual([
      'uid',
      'kind',
      'ref',
      'role_name',
      'parents',
      'source',
      'ends_at',
    ]);
    expect(sql.manifest).toMatchObject({
      within: { column: 'parents' },
      via: { column: 'source' },
      expiresAt: { column: 'ends_at' },
    });
  });

  it('turns rows into memberships and drops rows it cannot read', async () => {
    const { query, calls } = recording([
      {
        scope: 'tenant',
        id: 'o1',
        roles: ['member', 'admin', '', 3],
        within: { root: 'r1', bad: 7 },
        via: 'invite',
        expires_at: '1900000000',
        granted_by: 'u9',
        reason: 'onboarding',
        member_group: 'ops',
        managed_by: 'idp',
        seats: ['pro'],
      },
      { scope: 'team', id: 't1', roles: ['lead'], within: [], expires_at: 12 },
      { scope: 'team', id: 't2', roles: [] },
      { scope: 'team', id: 3, roles: ['lead'] },
      { scope: 'team', id: 't3', roles: 'lead', expires_at: '' },
    ]);
    const source = fromTable({ table: 'memberships', query });
    expect(await source.membershipsFor(principal, {})).toEqual([
      {
        scope: 'tenant',
        id: 'o1',
        within: { root: 'r1' },
        roles: ['admin', 'member'],
        via: 'invite',
        expiresAt: 1_900_000_000,
        grantedBy: 'u9',
        reason: 'onboarding',
        member: { group: 'ops' },
        managedBy: 'idp',
        entitlements: ['pro'],
      },
      { scope: 'team', id: 't1', roles: ['lead'], expiresAt: 12 },
    ]);
    expect(calls[0]?.values).toEqual(['u1']);
  });

  it('lists the members of one instance from a plain row array', async () => {
    const { query, calls } = recording(
      [
        { user_id: 'u1', scope: 'tenant', id: 'o1', roles: ['member'] },
        { user_id: 7, scope: 'tenant', id: 'o1', roles: ['member'] },
      ],
      'array',
    );
    const source = fromTable({ table: 'memberships', query });
    expect(await source.list?.({ scope: 'tenant', id: 'o1' })).toEqual([
      {
        principal: { id: 'u1' },
        membership: { scope: 'tenant', id: 'o1', roles: ['member'] },
      },
    ]);
    expect(calls[0]?.values).toEqual(['tenant', 'o1']);
  });

  it('describes SQL without a query and refuses to resolve', async () => {
    const source = fromTable({ table: 'memberships' });
    await expect(source.membershipsFor(principal, {})).rejects.toThrow(
      'the memberships membership source needs query to resolve memberships',
    );
  });

  it.each([
    [
      { table: 'members; drop table x' },
      "unsafe SQL identifier 'members; drop table x'",
    ],
    [
      { table: 'm', columns: { role: 'role"' } },
      `unsafe SQL identifier 'role"'`,
    ],
    [
      { table: 'm', suspension: { users: { table: 'p', id: 'id' } } },
      'a suspension table needs disabledAt or status',
    ],
    [
      {
        table: 'm',
        suspension: { users: { table: 'p', id: 'id', status: 'state' } },
      },
      'a suspension status column needs its active values',
    ],
  ])('rejects %j', (options, message) => {
    expect(() => fromTable(options).sql.select('$1')).toThrow(message);
  });
});

describe('fromJunction', () => {
  it('reads a one-scope table with a role column and ancestor columns', async () => {
    const { query, calls } = recording([
      {
        scope: 'project',
        id: 'p1',
        roles: ['editor'],
        within: { tenant: 'o1' },
      },
    ]);
    const source = fromJunction({
      table: 'project_members',
      scope: 'project',
      roles: 'role',
      within: { tenant: 'org_id' },
      expiresAt: 'until',
      grantedBy: 'added_by',
      reason: 'note',
      group: { column: 'squad' },
      managedBy: { column: 'owner' },
      seats: 'seats',
      suspension: {
        scopes: {
          tenant: { table: 'orgs', id: 'id', disabledAt: 'closed_at' },
          project: { table: 'projects', id: 'id', disabledAt: 'archived_at' },
          team: { table: 'teams', id: 'id', disabledAt: 'gone_at' },
        },
      },
      query,
    });
    expect(source.sql.scope).toBe('project');
    expect(source.sql.holds).toEqual(['project', 'tenant']);
    expect(source.sql.columns).toEqual([
      'user_id',
      'project_id',
      'org_id',
      'role',
      'until',
    ]);
    const select = source.sql.select('$1');
    expect(select).toContain(`'project'::text as scope`);
    expect(select).toContain(
      `jsonb_build_object('tenant', m."org_id"::text) as within`,
    );
    expect(select).toContain('m."squad"::text as member_group');
    expect(select).toContain('m."owner"::text as managed_by');
    expect(select).toContain('"public"."orgs"');
    expect(select).toContain('"public"."projects"');
    expect(select).not.toContain('"public"."teams"');
    expect(source.sql.list()).toContain(
      `$1::text = 'project' and m."project_id"::text = $2::text`,
    );
    expect(source.sql.manifest).toMatchObject({
      scope: { value: 'project' },
      role: { column: 'role' },
      within: { columns: { tenant: 'org_id' } },
      expiresAt: { column: 'until' },
    });
    expect(await source.membershipsFor(principal, {})).toEqual([
      {
        scope: 'project',
        id: 'p1',
        roles: ['editor'],
        within: { tenant: 'o1' },
      },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('gives every row fixed roles, a fixed via, group and identity-provider ownership', () => {
    const { sql } = fromJunction({
      table: 'customer_contacts',
      scope: 'customer',
      roles: ['contact'],
      via: 'contact',
      group: 'buyers',
      managedBy: 'idp',
    });
    const select = sql.select('$1');
    expect(select).toContain(`jsonb_build_array('contact') as roles`);
    expect(select).toContain(`'contact'::text as via`);
    expect(select).toContain(`'buyers'::text as member_group`);
    expect(select).toContain(`'idp'::text as managed_by`);
    expect(sql.managed).toBe('');
    expect(sql.manifest).toMatchObject({
      role: { value: ['contact'] },
      via: { value: 'contact' },
    });
  });

  it.each([
    [{ scope: 'Bad Scope', roles: 'role' }, "unsafe scope name 'Bad Scope'"],
    [{ scope: 'customer', roles: [] }, 'fromJunction needs at least one role'],
  ])('rejects %j', (options, message) => {
    expect(() => fromJunction({ table: 'contacts', ...options })).toThrow(
      message,
    );
  });
});

describe('authzVersion', () => {
  it.each([
    [[{ version: 4 }], 4],
    [[{ version: '7' }], 7],
    [[], 0],
    [[{ version: 'x' }], undefined],
  ])('reads %j as %s', async (rows, expected) => {
    const { query, calls } = recording(rows);
    const version = authzVersion({ query, schema: 'authz' });
    expect(await version(principal)).toBe(expected);
    expect(calls[0]).toEqual({
      text: 'select version from "authz"."permdock_authz_version" where user_id = $1',
      values: ['u1'],
    });
  });
});
