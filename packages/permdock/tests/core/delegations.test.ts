import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Permission, Snapshot } from '../../src/index.ts';

import { catalogDelegations } from '../../src/cli/catalog-doc.ts';
import {
  actor,
  allow,
  authenticated,
  createPermDock,
  definePermissions,
  definePolicy,
  delegatedPermissions,
  deny,
  fromSnapshot,
  relation,
  resource,
  role,
} from '../../src/index.ts';

const Post = z.object({ id: z.string(), authorId: z.string() });
const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update', 'delete'],
    relations: { owner: 'authorId' },
  }),
  billing: resource({ actions: ['read'] }),
});
const post = { id: 'p1', authorId: 'u1' };
type User = { readonly id: string; readonly roles: readonly string[] };
const subject = (user: User) => user;

const UNTIL = Date.parse('2027-06-01T00:00:00Z') / 1000;

const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read),
      allow(permissions.post.update),
      allow(permissions.post.delete),
      deny(permissions.post.delete, { where: { authorId: 'locked' } }),
    ]),
    role('admin', [allow(permissions.billing.read)]),
  ],
  delegations: [
    {
      from: 'member',
      to: actor('eve'),
      permissions: [permissions.post.read, permissions.post.update],
      validUntil: '2027-06-01T00:00:00Z',
    },
    {
      from: 'admin',
      to: { kind: 'eve', id: 'agent-billing' },
      permissions: [permissions.billing],
    },
  ],
  subject,
});

const member: User = { id: 'u1', roles: ['member'] };
const admin: User = { id: 'u2', roles: ['admin'] };
const eve = { id: 'agent-1', kind: 'eve' };
const billingAgent = { id: 'agent-billing', kind: 'eve' };

type Dock = Awaited<ReturnType<typeof createPermDock>>;

function unsigned(dock: Dock): Snapshot {
  const snapshot = dock.snapshot();
  if (snapshot instanceof Promise) {
    throw new Error('unsigned snapshot expected');
  }
  return snapshot;
}

function outcome(dock: Dock, permission: Permission, row?: unknown) {
  // SAFETY: every leaf here belongs to the policy under test; decide() accepts any row at runtime.
  const decision = dock.decide(permission as never, row as never);
  return decision.outcome === 'denied'
    ? decision.denials[0]?.reason
    : decision.outcome;
}

type Delegations = NonNullable<
  Parameters<
    typeof definePolicy<User, User, typeof permissions>
  >[1]['delegations']
>;

function define(delegations: Delegations) {
  return definePolicy(permissions, { subject, delegations });
}

describe('policy delegations', () => {
  it('normalises from, to and permissions and refuses malformed ones', () => {
    expect(policy.delegations).toEqual([
      {
        from: { kind: 'role', role: 'member', scope: 'global' },
        to: { kind: 'eve' },
        permissions: ['post.read', 'post.update'],
        validity: { until: UNTIL },
      },
      {
        from: { kind: 'role', role: 'admin', scope: 'global' },
        to: { kind: 'eve', id: 'agent-billing' },
        permissions: ['billing.read'],
      },
    ]);
    expect(Object.isFrozen(policy.delegations?.[0])).toBe(true);
    expect(() =>
      define([
        {
          from: relation(permissions.post, 'owner'),
          to: 'eve',
          permissions: [permissions.post.read],
        },
      ]),
    ).toThrow(/delegations\[0\]\.from names a relation/u);
    expect(() =>
      define([
        { from: actor('eve'), to: 'eve', permissions: [permissions.post.read] },
      ]),
    ).toThrow(/from names an actor/u);
    expect(() =>
      define([
        {
          from: 'member',
          to: { kind: '' },
          permissions: [permissions.post.read],
        },
      ]),
    ).toThrow(/needs an actor kind/u);
    expect(() =>
      define([{ from: 'member', to: 'eve', permissions: [] }]),
    ).toThrow(/permissions is empty/u);
    const other = definePermissions({ note: resource({ actions: ['read'] }) });
    expect(() =>
      define([{ from: 'member', to: 'eve', permissions: [other.note.read] }]),
    ).toThrow(/unknown permission 'note\.read'/u);
    expect(() =>
      define([
        {
          from: 'member',
          to: 'eve',
          permissions: [permissions.post.read],
          validFrom: 'yesterday',
        },
      ]),
    ).toThrow(/validFrom on 'delegations\[0\]'/u);
  });

  it('is part of the policy fingerprint', () => {
    const without = definePolicy(permissions, { roles: policy.roles, subject });
    const reordered = definePolicy(permissions, {
      roles: policy.roles,
      delegations: [
        {
          from: 'admin',
          to: { kind: 'eve', id: 'agent-billing' },
          permissions: [permissions.billing],
        },
        {
          from: 'member',
          to: actor('eve'),
          permissions: [permissions.post.update, permissions.post.read],
          validUntil: UNTIL,
        },
      ],
      subject,
    });
    expect(without.fingerprint).not.toBe(policy.fingerprint);
    expect(reordered.fingerprint).not.toBe(policy.fingerprint);
    expect(catalogDelegations(reordered)).toEqual(catalogDelegations(policy));
  });

  it('lets a matching actor use the delegated permissions without a token delegation', async () => {
    const dock = await createPermDock(policy, member, { actor: eve });
    expect(outcome(dock, permissions.post.read, post)).toBe('granted');
    expect(outcome(dock, permissions.post.update, post)).toBe('granted');
    expect(outcome(dock, permissions.post.delete, post)).toBe('not-delegated');
  });

  it('never exceeds the principal and never delegates a deny away', async () => {
    // The principal's grants decide first: a delegation adds nothing the user lacks.
    const dock = await createPermDock(policy, member, { actor: eve });
    expect(outcome(dock, permissions.billing.read)).toBe('no-grant');
    const asUser = await createPermDock(policy, member);
    expect(outcome(asUser, permissions.billing.read)).toBe('no-grant');
    const wide = definePolicy(permissions, {
      roles: policy.roles,
      delegations: [
        { from: 'member', to: 'eve', permissions: [permissions.post] },
      ],
      subject,
    });
    const agent = await createPermDock(wide, member, { actor: eve });
    expect(
      outcome(agent, permissions.post.delete, { id: 'p2', authorId: 'locked' }),
    ).toBe('deny');
    expect(outcome(agent, permissions.post.delete, post)).toBe('granted');
  });

  it('ignores delegations for another actor kind, another id, or a role the principal lacks', async () => {
    const other = await createPermDock(policy, member, {
      actor: { id: 'bot', kind: 'openai' },
    });
    expect(outcome(other, permissions.post.read, post)).toBe('no-delegation');
    const asAdmin = await createPermDock(policy, admin, { actor: eve });
    expect(outcome(asAdmin, permissions.billing.read)).toBe('no-delegation');
    const named = await createPermDock(policy, admin, { actor: billingAgent });
    expect(outcome(named, permissions.billing.read)).toBe('granted');
    const memberBilling = await createPermDock(policy, member, {
      actor: billingAgent,
    });
    expect(outcome(memberBilling, permissions.billing.read)).toBe('no-grant');
    // The kind-wide delegation still covers this eve agent for post.read.
    expect(outcome(memberBilling, permissions.post.read, post)).toBe('granted');
  });

  it('intersects with a token delegation: both must cover', async () => {
    const dock = await createPermDock(policy, member, {
      actor: eve,
      delegation: { scopes: ['post:read', 'post:delete'] },
    });
    expect(outcome(dock, permissions.post.read, post)).toBe('granted');
    expect(outcome(dock, permissions.post.update, post)).toBe('not-delegated');
    expect(outcome(dock, permissions.post.delete, post)).toBe('not-delegated');
  });

  it('stops applying after validUntil', async () => {
    const dock = await createPermDock(policy, member, { actor: eve });
    const [during] = dock.simulate([[permissions.post.read, post]], {
      now: UNTIL - 60,
    });
    expect(during?.outcome).toBe('granted');
    const [expired] = dock.simulate([[permissions.post.read, post]], {
      now: UNTIL + 60,
    });
    expect(expired?.outcome === 'denied' && expired.denials[0]?.reason).toBe(
      'no-delegation',
    );
  });

  it('matches non-role from grantees against the subject', async () => {
    const anyone = definePolicy(permissions, {
      roles: policy.roles,
      delegations: [
        {
          from: authenticated(),
          to: 'eve',
          permissions: [permissions.post.read],
        },
      ],
      subject,
    });
    const dock = await createPermDock(anyone, member, { actor: eve });
    expect(outcome(dock, permissions.post.read, post)).toBe('granted');
    expect(
      delegatedPermissions(
        anyone.delegations,
        { principal: null, context: {}, actor: eve },
        new Set(),
        0,
      ),
    ).toBeUndefined();
  });

  it('carries the ceiling on the snapshot and the client evaluator agrees', async () => {
    const dock = await createPermDock(policy, member, { actor: eve });
    const snapshot = unsigned(dock);
    expect(snapshot.delegated).toEqual(['post.read', 'post.update']);
    expect(snapshot.subject.delegation).toBeUndefined();
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.post.read, post)).toBe(true);
    expect(client.can(permissions.post.delete, post)).toBe(false);
    const decision = client.decide(permissions.post.delete, post);
    expect(decision.outcome === 'denied' && decision.denials[0]?.reason).toBe(
      'not-delegated',
    );
    const plain = unsigned(await createPermDock(policy, member));
    expect(plain.delegated).toBeUndefined();
    const other = unsigned(
      await createPermDock(policy, member, {
        actor: { id: 'bot', kind: 'openai' },
      }),
    );
    expect(other.delegated).toBeUndefined();
    expect(other.subject.delegation).toEqual({ scopes: [] });
  });
});
