import { describe, expect, it } from 'vitest';

import type { MembershipSource } from '../../src/core/interfaces.ts';
import type { Principal } from '../../src/core/subject.ts';

import { fromSnapshot } from '../../src/core/from-snapshot.ts';
import { plan } from '../../src/core/grantee.ts';
import { memoryEntitlementSource } from '../../src/core/interfaces.ts';
import {
  claimsFirst,
  composeMemberships,
  isExternallyManaged,
  mergeMemberships,
} from '../../src/core/memberships.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { allow, definePolicy, role } from '../../src/core/policy.ts';
import { parseSnapshot } from '../../src/core/snapshot.ts';
import { fromStripeEntitlements } from '../../src/core/stripe-entitlements.ts';
import {
  testEntitlementSource,
  testMembershipSource,
} from '../../src/testing/conformance.ts';

const Doc = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  doc: resource(Doc, {
    id: 'id',
    actions: ['read', 'delete', 'export'],
    relations: { org: { field: 'org_id', memberOf: 'organization' } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { organization: { key: 'org_id' } },
  roles: [
    role('owner', [allow([permissions.doc.read, permissions.doc.delete])], {
      on: 'organization',
    }),
    role('member', [allow(permissions.doc.read)], { on: 'organization' }),
  ],
  grants: [allow(permissions.doc.export, { to: plan('dev-mode') })],
  fresh: [permissions.doc.delete],
  subject: (user: Principal | null) => user,
});

const row = { id: 'd1', org_id: 'T' };

function source(
  memberships: MembershipSource['membershipsFor'],
  extra: Partial<MembershipSource> = {},
): MembershipSource {
  return { membershipsFor: memberships, ...extra };
}

describe('composeMemberships', () => {
  it('merges duplicate instances and keeps different kinds apart', async () => {
    const composed = composeMemberships([
      source(() => [
        { scope: 'organization', id: 'T', roles: ['member'], via: 'staff' },
      ]),
      source(async () => [
        { scope: 'organization', id: 'T', roles: ['owner'], via: 'staff' },
        { scope: 'organization', id: 'T', roles: ['member'], via: 'contact' },
      ]),
    ]);
    expect(await composed.membershipsFor({ id: 'u' }, {})).toEqual([
      {
        scope: 'organization',
        id: 'T',
        roles: ['member', 'owner'],
        via: 'staff',
      },
      { scope: 'organization', id: 'T', roles: ['member'], via: 'contact' },
    ]);
  });

  it('lists members across sources and reports the highest version', async () => {
    const composed = composeMemberships([
      source(() => [], {
        list: () => [
          {
            principal: { id: 'a' },
            membership: { scope: 'organization', id: 'T', roles: ['owner'] },
          },
        ],
        version: () => 3,
      }),
      source(() => [], {
        list: async () => [
          {
            principal: { id: 'a' },
            membership: { scope: 'organization', id: 'T', roles: ['member'] },
          },
          {
            principal: { id: 'b' },
            membership: { scope: 'organization', id: 'T', roles: ['member'] },
          },
        ],
        version: async () => 5,
      }),
      source(() => []),
    ]);
    expect(await composed.list?.({ scope: 'organization', id: 'T' })).toEqual([
      {
        principal: { id: 'a' },
        membership: {
          scope: 'organization',
          id: 'T',
          roles: ['owner', 'member'],
        },
      },
      {
        principal: { id: 'b' },
        membership: { scope: 'organization', id: 'T', roles: ['member'] },
      },
    ]);
    expect(await composed.version?.({ id: 'a' })).toBe(5);
    expect(composeMemberships([source(() => [])]).list === undefined).toBe(
      true,
    );
  });

  it('accepts an array as memberships and fails closed when one source throws', async () => {
    const permdock = await createPermDock(
      policy,
      { id: 'u', roles: [], tenant: 'T' },
      {
        memberships: [
          source(() => [{ scope: 'organization', id: 'T', roles: ['member'] }]),
          source(() => [{ scope: 'organization', id: 'T', roles: ['owner'] }]),
        ],
      },
    );
    expect(permdock.subject.principal?.memberships?.[0]?.roles).toEqual([
      'member',
      'owner',
    ]);
    const broken = await createPermDock(
      policy,
      { id: 'u', roles: [], tenant: 'T' },
      {
        memberships: [
          source(() => [{ scope: 'organization', id: 'T', roles: ['owner'] }]),
          source(async () => {
            throw new Error('down');
          }),
        ],
      },
    );
    expect(broken.can(permissions.doc.read, row)).toBe(false);
  });

  it('merges plain lists without a source', () => {
    expect(
      mergeMemberships([
        [{ scope: 'organization', id: 'T', roles: ['a'], expiresAt: 10 }],
        [{ scope: 'organization', id: 'T', roles: ['b'], expiresAt: 20 }],
      ]),
    ).toHaveLength(2);
  });
});

describe('composeMemberships edge cases', () => {
  it('merges resource memberships and has no version when no source knows one', async () => {
    const onDoc = { on: { resource: 'doc', id: 'd1' }, roles: ['viewer'] };
    const composed = composeMemberships([
      source(() => [], {
        list: () => [{ principal: { id: 'a' }, membership: onDoc }],
        version: () => undefined,
      }),
      source(() => [], {
        list: () => [
          {
            principal: { id: 'a' },
            membership: { ...onDoc, roles: ['editor'] },
          },
        ],
        version: () => Number.NaN,
      }),
    ]);
    expect({
      listed: await composed.list?.({ scope: 'doc', id: 'd1' }),
      version: await composed.version?.({ id: 'a' }),
    }).toEqual({
      listed: [
        {
          principal: { id: 'a' },
          membership: { ...onDoc, roles: ['viewer', 'editor'] },
        },
      ],
      version: undefined,
    });
  });
});

describe('claimsFirst', () => {
  const token: Principal = {
    id: 'u',
    roles: [],
    tenant: 'T',
    memberships: [{ scope: 'organization', id: 'T', roles: ['member'] }],
  };

  it('keeps token memberships and reads the source only when truncated', async () => {
    let calls = 0;
    const live = source(() => {
      calls += 1;
      return [{ scope: 'organization', id: 'T', roles: ['owner'] }];
    });
    const fromToken = await createPermDock(policy, token, {
      memberships: claimsFirst(live),
    });
    expect(calls).toBe(0);
    expect(fromToken.can(permissions.doc.read, row)).toBe(true);
    const truncated = await createPermDock(
      policy,
      { ...token, membershipsTruncated: true },
      { memberships: claimsFirst([live]) },
    );
    expect(calls).toBe(1);
    expect(truncated.subject.principal?.memberships?.[0]?.roles).toEqual([
      'owner',
    ]);
  });

  it('denies fresh permissions with stale-credentials until the token catches up', async () => {
    const owner: Principal = {
      ...token,
      memberships: [{ scope: 'organization', id: 'T', roles: ['owner'] }],
    };
    // SAFETY: owner.memberships is the scoped membership list declared just above.
    const live = source(() => owner.memberships as never);
    const at = (version: number | undefined, current: number) =>
      createPermDock(
        policy,
        version === undefined ? owner : { ...owner, authzVersion: version },
        { memberships: claimsFirst(live, { version: () => current }) },
      );
    const stale = await at(2, 3);
    expect(stale.subject.stale).toBe(true);
    expect(stale.decide(permissions.doc.delete, row)).toMatchObject({
      outcome: 'denied',
      denials: [{ reason: 'stale-credentials' }],
    });
    expect(stale.can(permissions.doc.read, row)).toBe(true);
    const snapshot = parseSnapshot(
      JSON.parse(JSON.stringify(stale.snapshot())),
    );
    expect(
      snapshot.grants.some((grant) => grant.permission === 'doc.delete'),
    ).toBe(false);
    expect(fromSnapshot(snapshot).can(permissions.doc.delete, row)).toBe(false);
    expect((await at(3, 3)).can(permissions.doc.delete, row)).toBe(true);
    expect((await at(undefined, 3)).can(permissions.doc.delete, row)).toBe(
      false,
    );
    const noVersion = await createPermDock(policy, owner, {
      memberships: claimsFirst(live),
    });
    expect(noVersion.can(permissions.doc.delete, row)).toBe(false);
    const liveOnly = await createPermDock(
      policy,
      { id: 'u', roles: [], tenant: 'T' },
      { memberships: live },
    );
    expect(liveOnly.subject.stale).toBeUndefined();
    expect(liveOnly.can(permissions.doc.delete, row)).toBe(true);
  });

  it('marks IdP-owned memberships', () => {
    expect(
      isExternallyManaged({
        scope: 'organization',
        id: 'T',
        roles: ['member'],
        managedBy: 'idp',
      }),
    ).toBe(true);
    expect(
      isExternallyManaged({ scope: 'organization', id: 'T', roles: ['x'] }),
    ).toBe(false);
  });
});

describe('entitlements and seats', () => {
  it('adds tenant entitlements to plans for the validated active tenant only', async () => {
    const entitlements = memoryEntitlementSource({ T: ['dev-mode'] });
    const member: Principal = {
      id: 'u',
      roles: [],
      tenant: 'T',
      memberships: [{ scope: 'organization', id: 'T', roles: ['member'] }],
    };
    const permdock = await createPermDock(policy, member, { entitlements });
    expect(permdock.subject.principal?.plans).toEqual(['dev-mode']);
    expect(permdock.can(permissions.doc.export, undefined)).toBe(true);
    const { tenant: _tenant, ...untenanted } = member;
    const outsider = await createPermDock(
      policy,
      { ...untenanted, memberships: [] },
      { entitlements, tenant: 'T' },
    );
    expect(outsider.can(permissions.doc.export, undefined)).toBe(false);
  });

  it('matches plan grantees against seats of memberships in the active tenant', async () => {
    const seated: Principal = {
      id: 'u',
      roles: [],
      tenant: 'T',
      memberships: [
        {
          scope: 'organization',
          id: 'T',
          roles: ['member'],
          entitlements: ['dev-mode'],
        },
        { scope: 'organization', id: 'B', roles: ['member'] },
      ],
    };
    expect(
      (await createPermDock(policy, seated)).can(
        permissions.doc.export,
        undefined,
      ),
    ).toBe(true);
    expect(
      (await createPermDock(policy, seated, { tenant: 'B' })).can(
        permissions.doc.export,
        undefined,
      ),
    ).toBe(false);
  });

  it('reads active Stripe entitlements across pages', async () => {
    const calls: unknown[] = [];
    const stripe = {
      entitlements: {
        activeEntitlements: {
          list: async (params: { starting_after?: string }) => {
            calls.push(params);
            return params.starting_after === undefined
              ? {
                  data: [{ id: 'ent_1', lookup_key: 'dev-mode' }],
                  has_more: true,
                }
              : {
                  data: [{ id: 'ent_2', lookup_key: 'sso' }],
                  has_more: false,
                };
          },
        },
      },
    };
    const stripeSource = fromStripeEntitlements({
      stripe,
      customer: (tenant) => (tenant === 'T' ? 'cus_1' : undefined),
    });
    expect(
      await stripeSource.entitlementsFor({ id: 'u' }, { tenant: 'T' }),
    ).toEqual(['dev-mode', 'sso']);
    expect(calls).toEqual([
      { customer: 'cus_1', limit: 100 },
      { customer: 'cus_1', limit: 100, starting_after: 'ent_1' },
    ]);
    expect(
      await stripeSource.entitlementsFor({ id: 'u' }, { tenant: 'B' }),
    ).toEqual([]);
    expect(await stripeSource.entitlementsFor({ id: 'u' }, {})).toEqual([]);
  });
});

describe('conformance runners', () => {
  testEntitlementSource(memoryEntitlementSource({ T: ['dev-mode'] }), {
    principal: { id: 'u' },
    tenant: 'T',
    expect: ['dev-mode'],
  });
  testMembershipSource(
    composeMemberships([
      {
        membershipsFor: (principal) =>
          principal.id === 'u'
            ? [{ scope: 'organization', id: 'T', roles: ['member'] }]
            : [],
        list: ({ id }) =>
          id === 'T'
            ? [
                {
                  principal: { id: 'u' },
                  membership: {
                    scope: 'organization',
                    id: 'T',
                    roles: ['member'],
                  },
                },
              ]
            : [],
        version: () => 1,
      },
    ]),
    { principals: [{ id: 'u' }, { id: 'v' }], policy },
  );
});

describe('claimsFirst forwarding', () => {
  it('forwards list and version from the inner source', async () => {
    const entry = {
      principal: { id: 'a' },
      membership: { scope: 'organization', id: 'T', roles: ['owner'] },
    };
    const wrapped = claimsFirst(
      source(() => [], { list: () => [entry], version: () => 7 }),
    );
    expect({
      listed: await wrapped.list?.({ scope: 'organization', id: 'T' }),
      version: await wrapped.version?.({ id: 'a' }),
      claimsFirst: wrapped.claimsFirst,
    }).toEqual({ listed: [entry], version: 7, claimsFirst: true });
  });
});
