import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { principal } from '../../src/conditions/refs.ts';
import {
  actor,
  anyone,
  asGrantee,
  assurance,
  authenticated,
  flattenGrantee,
  hasAnyone,
  matchGrantee,
  plan,
  relation,
  roleNameOf,
  roleScopeOf,
} from '../../src/core/grantee.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import {
  definePermissions,
  getResource,
  resource,
} from '../../src/core/permissions.ts';
import { allow, definePolicy, deny, role } from '../../src/core/policy.ts';
import { crud } from '../../src/core/presets.ts';
import { parseSnapshot } from '../../src/core/snapshot.ts';
import { isActor } from '../../src/core/subject.ts';
import {
  definePlans,
  defineRoles,
  findRole,
  isPlan,
  isRole,
  listPlans,
  listRoles,
} from '../../src/core/vocabulary.ts';

const Post = z.object({
  id: z.string(),
  authorId: z.string(),
  orgId: z.string(),
  published: z.boolean(),
});

const permissions = definePermissions({
  post: resource(
    Post,
    crud({
      relations: {
        author: 'authorId',
        org: { field: 'orgId', memberOf: 'tenant' },
      },
    }),
  ),
});

const roles = defineRoles({
  owner: { on: 'tenant', meta: { title: 'Owner' } },
  member: { on: 'tenant' },
  support: {},
});

const plans = definePlans({
  pro: { meta: { title: 'Pro' } },
});

const row = {
  id: 'p1',
  authorId: 'u1',
  orgId: 'acme',
  published: false,
};

describe('typed vocabulary', () => {
  it('builds frozen Role and Plan leaves', () => {
    expect(isRole(roles.owner)).toBe(true);
    expect(roles.owner.key).toBe('owner');
    expect(roles.owner.on).toBe('tenant');
    expect(roles.owner.assignable).toBe(true);
    expect(roles.support.assignable).toBe(false);
    expect(isPlan(plans.pro)).toBe(true);
    expect(listRoles(roles).map((item) => item.key)).toEqual(
      expect.arrayContaining(['member', 'owner', 'support']),
    );
    expect(listPlans(plans).map((item) => item.key)).toEqual(['pro']);
    expect(() => JSON.stringify(roles.owner)).not.toThrow();
  });

  it('exposes trees on the instance', async () => {
    const policy = definePolicy(
      { permissions, roles, plans },
      {
        scopes: { tenant: { key: 'orgId' } },
        principal: () => ({
          id: 'u1',
          roles: ['owner'],
          memberships: [{ tenant: 'acme', roles: ['owner'] }],
        }),
        grants: [allow(permissions.post.read, { to: roles.owner })],
      },
    );
    const permdock = await createPermDock(policy, { id: 'u1' });
    expect(permdock.roles.owner.key).toBe('owner');
    expect(permdock.plans.pro.key).toBe('pro');
    expect(permdock.permissions.post.read.key).toBe('post.read');
    expect(permdock.heldRoles().map((item) => item.key)).toContain('owner');
    expect(permdock.assignableRoles().map((item) => item.key)).toContain(
      'owner',
    );
  });
});

describe('grantee selectors', () => {
  it('grants anyone including anonymous', async () => {
    const policy = definePolicy(permissions, {
      principal: () => null,
      grants: [allow(permissions.post.read, { to: anyone() })],
    });
    const permdock = await createPermDock(policy, null);
    expect(permdock.can(permissions.post.read, row)).toBe(true);
    const denied = await createPermDock(
      definePolicy(permissions, {
        principal: () => null,
        grants: [allow(permissions.post.read, { to: authenticated() })],
      }),
      null,
    );
    expect(denied.can(permissions.post.read, row)).toBe(false);
  });

  it('matches relation, plan, actor, assurance and intersection', async () => {
    const policy = definePolicy(
      { permissions, roles, plans },
      {
        scopes: { tenant: { key: 'orgId' } },
        principal: (user: {
          readonly id: string;
          readonly plans?: readonly string[];
        }) => ({
          id: user.id,
          tenant: 'acme',
          ...(user.plans === undefined ? {} : { plans: user.plans }),
          memberships: [{ tenant: 'acme', roles: ['member'] }],
          assurance: { acr: 'mfa', amr: ['otp'], authTime: 1_700_000_000 },
        }),
        grants: [
          allow(permissions.post.update, {
            to: relation(permissions.post, 'author'),
          }),
          allow(permissions.post.delete, {
            to: [roles.member, plans.pro],
          }),
          allow(permissions.post.create, {
            to: [roles.member, assurance({ acr: ['mfa'] })],
          }),
          allow(permissions.post.read, { to: actor('mcp-client') }),
          deny(permissions.post.update, {
            to: anyone(),
            where: { published: true },
          }),
        ],
      },
    );
    const permdock = await createPermDock(
      policy,
      { id: 'u1', plans: ['pro'] },
      {
        actor: { id: 'agent', kind: 'mcp-client' },
        delegation: { authorizationDetails: [{ type: 'post' }] },
      },
    );
    expect(permdock.can(permissions.post.update, row)).toBe(true);
    expect(
      permdock.can(permissions.post.update, { ...row, authorId: 'other' }),
    ).toBe(false);
    expect(
      permdock.can(permissions.post.update, { ...row, published: true }),
    ).toBe(false);
    expect(permdock.can(permissions.post.delete, row)).toBe(true);
    expect(permdock.can(permissions.post.create)).toBe(true);
    expect(permdock.can(permissions.post.read, row)).toBe(true);
    const actions = permdock.actions(permissions.post, row);
    expect(actions.map((item) => item.action)).toEqual(
      expect.arrayContaining(['update', 'read', 'delete']),
    );
  });

  it('accepts role() sugar next to grants', async () => {
    const policy = definePolicy(
      { permissions, roles },
      {
        scopes: { tenant: { key: 'orgId' } },
        principal: () => ({
          id: 'u1',
          tenant: 'acme',
          memberships: [{ tenant: 'acme', roles: ['member'] }],
        }),
        roles: [role(roles.member, [allow(permissions.post.read)])],
      },
    );
    const permdock = await createPermDock(policy, { id: 'u1' });
    expect(permdock.can(permissions.post.read, row)).toBe(true);
  });

  it('throws when a top-level grant is missing to', () => {
    expect(() =>
      definePolicy(permissions, {
        principal: () => ({ id: 'u1' }),
        grants: [allow(permissions.post.read)],
      }),
    ).toThrow('missing to');
  });
});

describe('principal refs and snapshots', () => {
  it('evaluates principal.id in where', async () => {
    const policy = definePolicy(permissions, {
      principal: () => ({ id: 'u1', roles: ['member'] }),
      roles: [
        role('member', [
          allow(permissions.post.update, {
            where: { authorId: principal.id },
          }),
        ]),
      ],
    });
    const permdock = await createPermDock(policy, { id: 'u1' });
    expect(permdock.can(permissions.post.update, row)).toBe(true);
  });

  it('emits a snapshot with grant.to and vocabulary', async () => {
    const policy = definePolicy(
      { permissions, roles, plans },
      {
        scopes: { tenant: { key: 'orgId' } },
        principal: () => ({
          id: 'u1',
          memberships: [{ tenant: 'acme', roles: ['owner'] }],
        }),
        grants: [allow(permissions.post.read, { to: roles.owner })],
      },
    );
    const permdock = await createPermDock(policy, { id: 'u1' });
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected json snapshot');
    }
    expect(snapshot.v).toBe(1);
    expect(snapshot.grants[0]?.to).toMatchObject({
      kind: 'role',
      role: 'owner',
    });
    expect(snapshot.vocabulary?.roles?.['owner']?.key).toBe('owner');
    expect(parseSnapshot(snapshot).v).toBe(1);
  });
});

describe('grantee and vocabulary helpers', () => {
  const anonymous = { principal: null, context: {} };
  const member = {
    principal: { id: 'u1', roles: ['member'], plans: ['pro'] },
    context: {},
  };

  it('matches selector kinds and intersections', () => {
    expect(matchGrantee(anyone(), anonymous, 0, undefined).matched).toBe(true);
    expect(matchGrantee(authenticated(), anonymous, 0, undefined).matched).toBe(
      false,
    );
    expect(matchGrantee(authenticated(), member, 0, undefined).matched).toBe(
      true,
    );
    expect(matchGrantee(plan('pro'), member, 0, undefined).matched).toBe(true);
    expect(
      matchGrantee(
        plan(plans.pro),
        { principal: { id: 'u1' }, context: {} },
        0,
        undefined,
      ).matched,
    ).toBe(false);
    expect(
      matchGrantee(actor('mcp-client'), member, 0, undefined).matched,
    ).toBe(false);
    expect(matchGrantee(undefined, member, 0, undefined).reason).toBe(
      'no-grant',
    );
    expect(hasAnyone(anyone())).toBe(true);
    expect(hasAnyone(authenticated())).toBe(false);
    expect(roleNameOf(asGrantee(roles.owner))).toBe('owner');
    expect(roleScopeOf(asGrantee(roles.owner))).toBe('tenant');
    expect(flattenGrantee(asGrantee([roles.member, plans.pro]))).toHaveLength(
      2,
    );
    expect(asGrantee('admin')).toMatchObject({ kind: 'role', role: 'admin' });
    expect(asGrantee([anyone(), authenticated()])).toHaveLength(2);
    const node = getResource(permissions, 'post');
    expect(
      matchGrantee(relation(permissions.post, 'author'), member, 0, node).where,
    ).toMatchObject({ field: 'authorId' });
    expect(
      matchGrantee(relation(permissions.post, 'org'), member, 0, node).where,
    ).toMatchObject({ field: 'orgId' });
    expect(
      matchGrantee(relation(permissions.post, 'missing'), member, 0, node)
        .matched,
    ).toBe(false);
    expect(
      matchGrantee(relation(permissions.post, 'author'), anonymous, 0, node)
        .reason,
    ).toBe('anonymous');
  });

  it('covers assurance amr, acr and maxAge', () => {
    const subject = {
      principal: {
        id: 'u1',
        assurance: { acr: 'mfa', amr: ['otp'], authTime: 100 },
      },
      context: {},
    };
    expect(
      matchGrantee(assurance({ acr: 'pwd' }), subject, 100, undefined).matched,
    ).toBe(false);
    expect(
      matchGrantee(assurance({ amr: 'webauthn' }), subject, 100, undefined)
        .matched,
    ).toBe(false);
    expect(
      matchGrantee(assurance({ maxAge: 10 }), subject, 200, undefined).matched,
    ).toBe(false);
    expect(
      matchGrantee(
        assurance({ acr: 'mfa', amr: 'otp', maxAge: 50 }),
        subject,
        120,
        undefined,
      ).matched,
    ).toBe(true);
  });

  it('finds synthesises and rejects forbidden keys', () => {
    expect(findRole(roles, 'owner')?.key).toBe('owner');
    expect(findRole(undefined, 'owner')).toBeUndefined();
    expect(findRole(roles, '__proto__')).toBeUndefined();
    expect(isActor({ id: 'a', kind: 'mcp-client' })).toBe(true);
    expect(isActor(null)).toBe(false);
    expect(isRole({})).toBe(false);
    expect(isPlan(null)).toBe(false);
    expect(listRoles(undefined)).toEqual([]);
    expect(listPlans(undefined)).toEqual([]);
    expect(() => defineRoles({ constructor: {} })).toThrow(/forbidden/);
    expect(() => definePlans({ prototype: {} })).toThrow(/forbidden/);
  });
});
