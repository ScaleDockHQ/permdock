import { describe, expect, it } from 'vitest';

import { authorizeSql, supabaseRls } from '../../src/supabase/index.ts';

const members = {
  table: 'members',
  user: 'user_id',
  role: 'role',
  tenant: 'org_id',
  expiresAt: 'expires_at',
};

describe('supabaseRls', () => {
  it('wraps a single membership table as the tenant table and keeps a scoped map', () => {
    const scoped = { tenant: members };
    expect({
      single: supabaseRls({ memberships: members }).memberships,
      scoped: supabaseRls({ memberships: scoped }).memberships,
      none: supabaseRls().memberships,
    }).toEqual({ single: { tenant: members }, scoped, none: undefined });
  });
});

describe('authorizeSql', () => {
  it('qualifies a bare membership table and filters expired memberships', () => {
    const sql = authorizeSql({
      tenant: members,
      customRoles: { declared: ['owner'] },
    });
    expect({
      table: sql.includes('from "public"."members" m'),
      expiry: sql.match(/"expires_at" is null or m\."expires_at" > now\(\)/gu)
        ?.length,
      schemaTable: authorizeSql({
        tenant: { ...members, table: 'auth_schema.members' },
      }).includes('from "auth_schema"."members" m'),
    }).toEqual({ table: true, expiry: 2, schemaTable: true });
  });

  it('denies tenant requests when the membership table has no tenant column', () => {
    const sql = authorizeSql({
      tenant: { table: 'members', user: 'u', role: 'r' },
    });
    expect(sql).toContain('-- no memberships table configured');
  });

  it('emits user and scope suspension guards for disabledAt and status columns', () => {
    const sql = authorizeSql({
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
    expect({
      user: sql.includes(
        'exists (select 1 from "public"."profiles" s where s."id" = uid and s."banned_at" is null)',
      ),
      scope: sql.includes(
        `s."id"::text = requested_tenant and s."state"::text = any(array['active', 'o''k']::text[])`,
      ),
    }).toEqual({ user: true, scope: true });
  });

  it('rejects incomplete suspension rows and unsafe identifiers', () => {
    const attempts = [
      () => authorizeSql({ suspension: { users: { table: 'p', id: 'id' } } }),
      () =>
        authorizeSql({
          suspension: { users: { table: 'p', id: 'id', status: 's' } },
        }),
      () =>
        authorizeSql({
          suspension: {
            users: { table: 'p', id: 'id', status: 's', active: [] },
          },
        }),
      () => authorizeSql({ schema: 'public; drop' }),
      () => authorizeSql({ scope: 'Tenant' }),
    ];
    const messages = attempts.map((attempt) => {
      try {
        attempt();
        return 'no error';
      } catch (error) {
        return error instanceof TypeError ? 'TypeError' : 'other';
      }
    });
    expect(messages).toEqual([
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
      'TypeError',
    ]);
  });

  it('writes jwt mode with custom roles and suspension guards on auth.uid()', () => {
    const sql = authorizeSql({
      authorize: 'jwt',
      scope: 'workspace',
      customRoles: { declared: [] },
      suspension: {
        users: { table: 'profiles', id: 'id', disabledAt: 'banned_at' },
      },
    });
    expect({
      scope: sql.includes(`m ->> 'scope' = 'workspace'`),
      custom: sql.includes(`not (r.role = any('{}'::text[]))`),
      guard: sql.includes('s."id" = (select auth.uid())'),
    }).toEqual({ scope: true, custom: true, guard: true });
  });
});
