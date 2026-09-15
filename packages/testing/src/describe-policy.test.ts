import { readFileSync } from 'node:fs';
import {
  actor,
  allow,
  anyone,
  assurance,
  authenticated,
  definePermissions,
  definePlans,
  definePolicy,
  defineRoles,
  deny,
  principal,
  relation,
  resource,
  role,
  sqlFunction,
} from 'permdock';
import { memoryLimitStore, memoryRoleSource, memorySink } from 'permdock';
import { memoryApprovalStore } from 'permdock/approvals';
import { joseTokenSigner, joseTokenVerifier } from 'permdock/jwt';
import { memoryDirectoryStore } from 'permdock/scim';
import { memoryReplayStore } from 'permdock/ssf';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  testApprovalStore,
  testDecisionSink,
  testLimitStore,
  testDirectoryStore,
  testReplayStore,
  testMembershipSource,
  testRoleSource,
  testSnapshotSource,
  testSubjectResolver,
  testTokenSigner,
  testTokenVerifier,
  testWhereCompiler,
} from './conformance.ts';
import { describePolicy } from './describe-policy.ts';
import { jwtFixtureJwks } from './jwt-fixtures.ts';
import { snapshotFixture } from './snapshot-fixture.ts';

const Post = z.object({
  id: z.string(),
  authorId: z.string(),
  orgId: z.string(),
  published: z.boolean(),
});

const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update', 'delete', 'publish'],
    collection: ['create', 'list'],
  }),
});

type User = {
  readonly id: string;
  readonly orgId: string;
  readonly roles: readonly string[];
};

const member = role('member', [
  allow(permissions.post.read),
  allow(permissions.post.list),
  allow(permissions.post.create),
  allow(permissions.post.update, { where: { authorId: principal.id } }),
  allow(permissions.post.delete, {
    where: { authorId: principal.id },
    approval: 'human',
  }),
]);

const admin = role('admin', [
  ...member.grants,
  allow(permissions.post.update),
  allow(permissions.post.delete),
  allow(permissions.post.publish),
  deny(permissions.post.publish, { where: { published: true } }),
]);

const policy = definePolicy(permissions, {
  roles: [member, admin],
  subject: (user: User | null) =>
    user === null
      ? null
      : { id: user.id, orgId: user.orgId, roles: user.roles },
});

const ownPost = { id: 'p1', authorId: 'u1', orgId: 'o1', published: false };
const otherPost = { id: 'p2', authorId: 'u9', orgId: 'o1', published: true };

describePolicy(policy, {
  subjects: {
    anonymous: null,
    member: { id: 'u1', orgId: 'o1', roles: ['member'] },
    admin: { id: 'u2', orgId: 'o1', roles: ['admin'] },
  },
  fixtures: { ownPost, otherPost },
  matrix: {
    [permissions.post.create.key]: {
      anonymous: 'denied',
      member: 'granted',
      admin: 'granted',
    },
    [permissions.post.list.key]: {
      anonymous: 'denied',
      member: 'granted',
      admin: 'granted',
    },
    [permissions.post.read.key]: {
      ownPost: { anonymous: 'denied', member: 'granted', admin: 'granted' },
      otherPost: { anonymous: 'denied', member: 'granted', admin: 'granted' },
    },
    [permissions.post.update.key]: {
      ownPost: { anonymous: 'denied', member: 'granted', admin: 'granted' },
      otherPost: { anonymous: 'denied', member: 'denied', admin: 'granted' },
    },
    [permissions.post.delete.key]: {
      ownPost: {
        anonymous: 'denied',
        member: 'approval-required',
        admin: 'granted',
      },
      otherPost: { anonymous: 'denied', member: 'denied', admin: 'granted' },
    },
    [permissions.post.publish.key]: {
      ownPost: { anonymous: 'denied', member: 'denied', admin: 'granted' },
      otherPost: { anonymous: 'denied', member: 'denied', admin: 'denied' },
    },
  },
});

const sqlFunctionPolicy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read, {
        where: sqlFunction('job_permitted', {
          args: [{ field: 'id' }],
          twin: { authorId: principal.id },
        }),
      }),
    ]),
  ],
  subject: (user: User | null) =>
    user === null
      ? null
      : { id: user.id, orgId: user.orgId, roles: user.roles },
});

describePolicy(sqlFunctionPolicy, {
  exhaustive: false,
  subjects: {
    member: { id: 'u1', orgId: 'o1', roles: ['member'] },
    other: { id: 'u9', orgId: 'o1', roles: ['member'] },
  },
  fixtures: { ownPost, otherPost },
  matrix: {
    [permissions.post.read.key]: {
      ownPost: { member: 'granted', other: 'denied' },
      otherPost: { member: 'denied', other: 'granted' },
    },
  },
});

describe('snapshotFixture', () => {
  it('returns snapshot v3 JSON', async () => {
    const snapshot = await snapshotFixture(policy, {
      id: 'u1',
      orgId: 'o1',
      roles: ['member'],
    });
    expect(snapshot.v).toBe(3);
    expect(snapshot.roles).toContain('member');
  });

  it('accepts include, tenants and simulated previews', async () => {
    const snapshot = await snapshotFixture(
      policy,
      { id: 'u1', orgId: 'o1', roles: ['member'] },
      {
        include: [permissions.post.read],
        tenants: 'all',
        simulated: true,
        tenant: 'o1',
      },
    );
    expect(snapshot.v).toBe(3);
    expect(snapshot.simulated).toBe(true);
  });
});

describePolicy(policy, {
  exhaustive: false,
  subjects: { member: { id: 'u1', orgId: 'o1', roles: ['member'] } },
  matrix: {
    [permissions.post.create.key]: { member: { outcome: 'granted' } },
    [permissions.post.list.key]: {
      member: { outcome: 'granted', denials: [{ reason: 'no-grant' }] },
    },
  },
});

const quotaPermissions = definePermissions({
  report: resource(z.object({ id: z.string() }), {
    id: 'id',
    actions: ['export'],
  }),
});

const quotaPolicy = definePolicy(quotaPermissions, {
  roles: [
    role('member', [
      allow(quotaPermissions.report.export, {
        limit: { count: 10, per: 'hour' },
      }),
    ]),
  ],
  subject: (user: { readonly id: string; readonly roles: readonly string[] }) =>
    user,
});

describePolicy(quotaPolicy, {
  exhaustive: false,
  options: { limits: memoryLimitStore() },
  subjects: { member: { id: 'u1', roles: ['member'] } },
  fixtures: { report: { id: 'r1' } },
  matrix: {
    [quotaPermissions.report.export.key]: {
      report: { member: 'granted' },
    },
  },
});

describePolicy(quotaPolicy, {
  exhaustive: false,
  subjects: { member: { id: 'u1', roles: ['member'] } },
  fixtures: { report: { id: 'r1' } },
  matrix: {
    [quotaPermissions.report.export.key]: {
      report: {
        member: {
          outcome: 'denied',
          denials: [{ reason: 'limit-unavailable' }],
        },
      },
    },
  },
});

describePolicy(policy, {
  exhaustive: false,
  options: {
    delegation: { access: [{ type: 'post', actions: ['read'] }] },
  },
  subjects: { admin: { id: 'u2', orgId: 'o1', roles: ['admin'] } },
  fixtures: { ownPost },
  matrix: {
    [permissions.post.read.key]: {
      ownPost: { admin: 'granted' },
    },
    [permissions.post.publish.key]: {
      ownPost: {
        admin: { outcome: 'denied', denials: [{ reason: 'not-delegated' }] },
      },
    },
  },
});

describe('conformance runners', () => {
  testLimitStore(memoryLimitStore());

  testSubjectResolver(
    (input: unknown) => {
      if (input === null) {
        return { principal: null, context: {} };
      }
      return { principal: { id: 'u1' }, context: {} };
    },
    { invalid: null },
  );

  testMembershipSource(
    {
      membershipsFor: () => [{ tenant: 'o1', roles: ['viewer'] }],
    },
    {
      principals: [{ id: 'alice' }],
      expect: { alice: [{ tenant: 'o1', roles: ['viewer'] }] },
    },
  );

  testMembershipSource(
    {
      membershipsFor(): never {
        throw new Error('nope');
      },
    },
    { principals: [{ id: 'bob' }] },
  );

  testRoleSource(
    {
      rolesFor: () => [{ tenant: 'o1', name: 'staff', includes: ['member'] }],
      assignable: () => ['member'],
    },
    { tenant: 'o1', declared: ['member'] },
  );

  testDecisionSink({
    write: () => undefined,
    flush: () => undefined,
  });

  testSnapshotSource({
    get: () => ({
      v: 1,
      issuedAt: 1,
      subject: { principal: null, context: {} },
      roles: [],
      grants: [],
      tenants: [],
    }),
  });

  testSnapshotSource({
    get: () => ({
      v: 2,
      issuedAt: 1,
      subject: { principal: null, context: {} },
      roles: [],
      grants: [],
      tenants: [],
    }),
    subscribe: () => () => undefined,
  });

  testWhereCompiler(() => false, { target: {} });

  testApprovalStore(memoryApprovalStore());

  testDirectoryStore(memoryDirectoryStore(), {
    tenants: ['o_acme', 'o_globex'],
  });

  testReplayStore(memoryReplayStore());

  testTokenVerifier(
    joseTokenVerifier({
      jwks: jwtFixtureJwks,
      issuer: 'https://login.example.com',
      audience: 'https://api.example.com',
      algorithms: ['Ed25519'],
    }),
  );

  it('ships one signed-output fixture per typ', () => {
    const fixtures = JSON.parse(
      readFileSync(
        new URL('../fixtures/jwt/signed-outputs.json', import.meta.url),
        'utf8',
      ),
    ) as Record<string, string>;
    expect(Object.keys(fixtures).toSorted()).toEqual([
      'permdock-approval+jwt',
      'permdock-decisions+jwt',
      'permdock-snapshot+jwt',
    ]);
  });

  testTokenSigner(
    joseTokenSigner({
      key: {
        crv: 'Ed25519',
        d: 'qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4',
        x: '79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ',
        kty: 'OKP',
        kid: '2026-09',
        alg: 'Ed25519',
      },
      alg: 'Ed25519',
      kid: '2026-09',
      issuer: 'https://app.example.com',
    }),
    {
      verifier: joseTokenVerifier({
        jwks: jwtFixtureJwks,
        typ: 'permdock-snapshot+jwt',
      }),
    },
  );
});

const selectorPermissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update', 'delete', 'publish'],
    collection: ['list'],
    relations: { author: 'authorId' },
  }),
});

const selectorRoles = defineRoles({
  owner: {},
});

const selectorPlans = definePlans({
  pro: {},
});

const selectorPolicy = definePolicy(
  {
    permissions: selectorPermissions,
    roles: selectorRoles,
    plans: selectorPlans,
  },
  {
    principal: (
      user: {
        readonly id: string;
        readonly roles?: readonly string[];
        readonly plans?: readonly string[];
        readonly assurance?: { readonly acr?: string };
      } | null,
    ) =>
      user === null
        ? null
        : {
            id: user.id,
            roles: user.roles ?? [],
            plans: user.plans,
            assurance: user.assurance,
          },
    grants: [
      allow(selectorPermissions.post.read, { to: anyone() }),
      allow(selectorPermissions.post.list, { to: authenticated() }),
      allow(selectorPermissions.post.update, {
        to: relation(selectorPermissions.post, 'author'),
      }),
      allow(selectorPermissions.post.delete, {
        to: [selectorRoles.owner, selectorPlans.pro],
      }),
      allow(selectorPermissions.post.publish, {
        to: [actor('mcp-client'), assurance({ acr: ['mfa'] })],
      }),
      deny(selectorPermissions.post.publish, {
        to: anyone(),
        where: { published: true },
      }),
    ],
  },
);

describePolicy(selectorPolicy, {
  exhaustive: false,
  subjects: {
    anonymous: null,
    member: { id: 'u1' },
    ownerPro: { id: 'u1', roles: ['owner'], plans: ['pro'] },
    ownerFree: { id: 'u1', roles: ['owner'] },
    agent: {
      principal: { id: 'u1', assurance: { acr: 'mfa' } },
      actor: { id: 'agent', kind: 'mcp-client' },
      context: {},
    },
  },
  fixtures: { ownPost, otherPost },
  matrix: {
    [selectorPermissions.post.read.key]: {
      ownPost: {
        anonymous: 'granted',
        member: 'granted',
        ownerPro: 'granted',
      },
    },
    [selectorPermissions.post.list.key]: {
      anonymous: 'denied',
      member: 'granted',
    },
    [selectorPermissions.post.update.key]: {
      ownPost: { anonymous: 'denied', member: 'granted' },
      otherPost: { anonymous: 'denied', member: 'denied' },
    },
    [selectorPermissions.post.delete.key]: {
      ownPost: {
        ownerPro: 'granted',
        ownerFree: 'denied',
        member: 'denied',
      },
    },
    [selectorPermissions.post.publish.key]: {
      ownPost: { agent: 'granted', member: 'denied' },
      otherPost: { agent: 'denied' },
    },
  },
});
