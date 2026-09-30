import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  betterAuthRoleSource,
  onRoleChange,
  rolesFromAccessControl,
  subjectFromBetterAuth,
} from '../../src/better-auth/index.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { memorySink } from '../../src/core/sink.ts';

const Post = z.object({ id: z.string(), authorId: z.string() });

const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update', 'delete'],
    collection: ['create'],
  }),
});

const session = {
  user: {
    id: 'user-1',
    email: 'ada@example.com',
    name: 'Ada',
    image: 'https://example.com/ada.png',
    role: 'support',
    plan: 'pro',
  },
  session: {
    id: 'sess-1',
    activeOrganizationId: 'o_acme',
    expiresAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  members: [
    { organizationId: 'o_acme', role: 'member,billing-admin' },
    { organizationId: 'o_other', role: 'admin' },
  ],
  teamMembers: [{ organizationId: 'o_acme', teamId: 't_design', role: 'lead' }],
};

// Response shapes documented by the Better Auth organization plugin
// (`listOrganizations`, `listMembers`, `getActiveMember`, `listUserTeams`).
const ORGANIZATIONS = [
  {
    id: 'o_acme',
    name: 'Acme',
    slug: 'acme',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'o_globex',
    name: 'Globex',
    slug: 'globex',
    createdAt: '2026-01-02T00:00:00.000Z',
  },
];

function member(
  id: string,
  organizationId: string,
  userId: string,
  role: string,
) {
  return {
    id,
    organizationId,
    userId,
    role,
    createdAt: '2026-01-01T00:00:00.000Z',
    user: {
      id: userId,
      name: userId,
      email: `${userId}@example.com`,
      image: null,
    },
  };
}

const ACME_MEMBERS = {
  members: [
    member('m_1', 'o_acme', 'u_alice', 'owner'),
    member('m_2', 'o_acme', 'u_bob', 'member'),
  ],
  total: 2,
};

const GLOBEX_MEMBERS = {
  members: [
    member('m_3', 'o_globex', 'u_carol', 'owner'),
    member('m_4', 'o_globex', 'u_bob', 'admin'),
  ],
  total: 2,
};

const USER_TEAMS = [
  {
    id: 't_design',
    name: 'Design',
    organizationId: 'o_acme',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
];

describe('subjectFromBetterAuth', () => {
  it('never throws and fails closed to anonymous', async () => {
    await expect(subjectFromBetterAuth({}, null)).resolves.toMatchObject({
      principal: null,
    });
    await expect(subjectFromBetterAuth({}, undefined)).resolves.toMatchObject({
      principal: null,
    });
    await expect(
      subjectFromBetterAuth({}, { cookie: 'raw' }),
    ).resolves.toMatchObject({ principal: null });
    await expect(
      subjectFromBetterAuth({}, { user: { name: 'no-id' } }),
    ).resolves.toMatchObject({ principal: null });
  });

  it('maps session identity, global admin role, org and team memberships', async () => {
    const subject = await subjectFromBetterAuth({}, session);
    expect(subject.principal?.id).toBe('user-1');
    expect(subject.principal?.tenant).toBe('o_acme');
    expect(subject.principal?.roles).toEqual(['support']);
    expect(subject.principal?.email).toBe('ada@example.com');
    expect(subject.session).toBe('sess-1');
    expect(subject.expiresAt).toBe(1_767_225_600);
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'o_acme', roles: ['member', 'billing-admin'] },
      { tenant: 'o_other', roles: ['admin'] },
      {
        tenant: 'o_acme',
        team: 't_design',
        roles: ['lead'],
        via: 'team:t_design',
      },
    ]);
    expect(subject.principal?.claims).toMatchObject({ plan: 'pro' });
    expect(subject.principal?.claims).not.toHaveProperty('name');
    expect(subject.principal?.claims).not.toHaveProperty('image');
  });

  it('limits memberships to the active organization when requested', async () => {
    const subject = await subjectFromBetterAuth({}, session, {
      memberships: 'active',
    });
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'o_acme', roles: ['member', 'billing-admin'] },
      {
        tenant: 'o_acme',
        team: 't_design',
        roles: ['lead'],
        via: 'team:t_design',
      },
    ]);
  });

  it('loads only the signed-in member from organization plugin responses', async () => {
    const calls: unknown[] = [];
    const subject = await subjectFromBetterAuth(
      {
        api: {
          listOrganizations: async () => ORGANIZATIONS,
          listMembers: async (args) => {
            calls.push(args?.query);
            return args?.query?.organizationId === 'o_acme'
              ? ACME_MEMBERS
              : GLOBEX_MEMBERS;
          },
          listUserTeams: async () => USER_TEAMS,
        },
      },
      { user: { id: 'u_bob' }, session: { activeOrganizationId: 'o_acme' } },
    );
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'o_acme', roles: ['member'] },
      { tenant: 'o_globex', roles: ['admin'] },
    ]);
    expect(calls).toContainEqual(
      expect.objectContaining({
        organizationId: 'o_acme',
        filterField: 'userId',
        filterOperator: 'eq',
        filterValue: 'u_bob',
      }),
    );
  });

  it('uses getActiveMember for the active organization', async () => {
    const subject = await subjectFromBetterAuth(
      {
        api: {
          getActiveMember: async () => ACME_MEMBERS.members[1],
          listMembers: async () => ACME_MEMBERS,
        },
      },
      { user: { id: 'u_bob' }, session: { activeOrganizationId: 'o_acme' } },
      { memberships: 'active' },
    );
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'o_acme', roles: ['member'] },
    ]);
  });

  it('drops member rows that belong to another user', async () => {
    const subject = await subjectFromBetterAuth(
      {
        api: {
          getActiveMember: async () => ACME_MEMBERS.members[0],
        },
      },
      { user: { id: 'u_bob' }, session: { activeOrganizationId: 'o_acme' } },
      { memberships: 'active' },
    );
    expect(subject.principal?.memberships).toEqual([]);
    const injected = await subjectFromBetterAuth(
      {},
      {
        user: { id: 'u_bob' },
        session: {},
        members: [
          { organizationId: 'o_acme', userId: 'u_alice', role: 'owner' },
        ],
      },
    );
    expect(injected.principal?.memberships).toEqual([]);
  });

  it('skips one organization whose lookup fails and keeps the rest', async () => {
    const subject = await subjectFromBetterAuth(
      {
        api: {
          listOrganizations: async () => ORGANIZATIONS,
          listMembers: async (args) => {
            if (args?.query?.organizationId === 'o_acme') {
              throw new Error('unavailable');
            }
            return GLOBEX_MEMBERS;
          },
        },
      },
      { user: { id: 'u_bob' }, session: {} },
    );
    expect(subject.principal?.memberships).toEqual([
      { tenant: 'o_globex', roles: ['admin'] },
    ]);
  });

  it('drops extra fields when the schema fails and never uses profile fields', async () => {
    const subject = await subjectFromBetterAuth({}, session, {
      schema: z.object({ plan: z.number() }),
    });
    expect(subject.principal?.id).toBe('user-1');
    expect(subject.principal?.claims).toBeUndefined();
  });

  it('drops undeclared global roles when declared is set', async () => {
    const subject = await subjectFromBetterAuth({}, session, {
      declared: ['admin'],
    });
    expect(subject.principal?.roles).toEqual([]);
  });

  it('treats a thrown membership source as no memberships', async () => {
    const subject = await subjectFromBetterAuth(
      {
        api: {
          listOrganizations: async () => {
            throw new Error('unavailable');
          },
        },
      },
      { user: { id: 'user-3', role: 'support' }, session: {} },
    );
    expect(subject.principal?.id).toBe('user-3');
    expect(subject.principal?.memberships).toEqual([]);
  });
});

describe('rolesFromAccessControl', () => {
  it('maps matching statements and reports unmatched pairs', () => {
    const seeded = rolesFromAccessControl(
      {
        ac: {},
        roles: {
          member: { statements: { post: ['read', 'create'] } },
          admin: {
            statements: { post: ['read', 'delete'], ghost: ['haunt'] },
          },
        },
      },
      permissions,
      { on: 'tenant' },
    );
    expect(seeded.map((item) => item.name)).toEqual(['member', 'admin']);
    expect(seeded[0]?.grants.map((grant) => grant.permission.key)).toEqual([
      'post.read',
      'post.create',
    ]);
    expect(seeded[0]?.grants[0]?.scope).toBe('tenant');
    expect(seeded.unmatched).toEqual([
      { role: 'admin', resource: 'ghost', action: 'haunt' },
    ]);
  });
});

describe('betterAuthRoleSource', () => {
  it('includes declared assignable roles whose statements the dynamic role covers', async () => {
    const source = betterAuthRoleSource(
      {
        api: {
          listOrganizationRoles: async () => [
            {
              role: 'billing-admin',
              permission: { post: ['read', 'create', 'update'] },
            },
            { role: 'mystery', permission: { ghost: ['haunt'] } },
          ],
        },
      },
      {
        assignable: [
          { name: 'member', statements: { post: ['read', 'create'] } },
          {
            name: 'editor',
            statements: { post: ['read', 'create', 'update'] },
          },
        ],
      },
    );
    await expect(source.rolesFor('o_acme')).resolves.toEqual([
      {
        tenant: 'o_acme',
        name: 'billing-admin',
        includes: ['member', 'editor'],
      },
      { tenant: 'o_acme', name: 'mystery', includes: [] },
    ]);
    expect(source.assignable?.('o_acme')).toEqual(['member', 'editor']);
  });

  it('resolves to nothing when the organization role API throws', async () => {
    const source = betterAuthRoleSource({
      api: {
        listOrganizationRoles: async () => {
          throw new Error('down');
        },
      },
    });
    await expect(source.rolesFor('o_acme')).resolves.toEqual([]);
  });
});

describe('onRoleChange', () => {
  it('forwards the Better Auth hook payload to the refresh callback', async () => {
    const seen: unknown[] = [];
    const hook = onRoleChange((event) => {
      seen.push(event);
    });
    await hook({ userId: 'user-1', organizationId: 'o_acme' });
    expect(seen).toEqual([{ userId: 'user-1', organizationId: 'o_acme' }]);
  });

  it('writes a membership event when a sink is given', async () => {
    const sink = memorySink();
    const hook = onRoleChange(() => undefined, { sink });
    await hook({
      userId: 'user-1',
      organizationId: 'o_acme',
      previousRole: 'member',
      role: 'admin',
      teamId: 't_1',
      by: { id: 'admin-1', kind: 'user' },
    });
    expect(sink.events()).toEqual([
      expect.objectContaining({
        type: 'membership',
        source: 'better-auth',
        operation: 'changed',
        principal: { id: 'user-1' },
        scope: 'team',
        id: 't_1',
        within: { tenant: 'o_acme' },
        roles: { added: ['admin'], removed: ['member'] },
        by: { id: 'admin-1', kind: 'user' },
      }),
    ]);
  });
});
