import { describe } from 'vitest';

import type {
  RelationSource,
  TokenSigner,
  TokenVerifier,
} from '../../src/core/interfaces.ts';

import { memoryApprovalStore } from '../../src/approvals/index.ts';
import { memoryPolicySource } from '../../src/core/hosted.ts';
import { memoryLimitStore } from '../../src/core/limits.ts';
import { definePermissions, resource } from '../../src/core/permissions.ts';
import { definePolicy, role } from '../../src/core/policy.ts';
import { defineRoles } from '../../src/core/vocabulary.ts';
import { generateApiKey } from '../../src/server/credentials.ts';
import { memoryReplayStore } from '../../src/ssf/index.ts';
import {
  testApprovalStore,
  testCredentialVerifier,
  testDecisionSink,
  testEntitlementSource,
  testLimitStore,
  testMembershipSource,
  testPolicySource,
  testRelationSource,
  testReplayStore,
  testRoleSource,
  testSnapshotSource,
  testTokenSigner,
  testWhereCompiler,
} from '../../src/testing/conformance.ts';
import { relations } from '../fixtures/graph.ts';

describe('testMembershipSource with list and version', () => {
  const memberships = {
    alice: [
      { scope: 'tenant', id: 'o1', roles: ['admin'] },
      { on: { resource: 'doc', id: 'd1' }, roles: ['viewer'] },
    ],
  } as const;
  testMembershipSource(
    {
      membershipsFor: (principal) => {
        if (principal.id === 'broken') {
          throw new Error('directory down');
        }
        return principal.id === 'alice' ? [...memberships.alice] : [];
      },
      list: ({ scope, id }) =>
        scope === 'tenant' && id === 'o1'
          ? [{ principal: { id: 'alice' }, membership: memberships.alice[0] }]
          : [],
      version: (principal) => (principal.id === 'alice' ? 3 : undefined),
    },
    {
      principals: [{ id: 'alice' }, { id: 'broken' }, { id: 'nobody' }],
      expect: { nobody: [] },
    },
  );
});

describe('testRelationSource over the graph fixture', () => {
  testRelationSource(relations, {
    objects: [
      { resource: 'folder', id: 'deep' },
      { resource: 'folder', id: 'platform', relation: 'viewer' },
    ],
    expect: {
      ancestors: { 'folder:deep': ['platform', 'eng', 'root'] },
      holders: { 'folder:platform#viewer': ['team:eng-team#member'] },
      links: { 'folder:eng>team': 'eng-team' },
    },
  });
});

describe('testRelationSource with periods and no objects', () => {
  const timed: RelationSource = {
    ancestors: () => ({ ancestors: [] }),
    related: (query) =>
      query.id === 'r1'
        ? [{ principal: { id: 'u1' }, startsAt: 10, expiresAt: 20 }]
        : [],
  };
  testRelationSource(timed, {
    objects: [{ resource: 'room', id: 'r1', relation: 'guest' }],
    expect: { holders: { 'room:r1#guest': ['u1'] } },
  });
  testRelationSource(timed, { objects: [] });
});

describe('testRoleSource with declared role leaves and a policy ceiling', () => {
  const permissions = definePermissions({
    doc: resource({ actions: ['read', 'update'] }),
  });
  const roles = defineRoles({ editor: { assignable: true } });
  const policy = definePolicy(
    { permissions, roles },
    {
      roles: [role(roles.editor, [])],
      subject: () => null,
    },
  );
  testRoleSource(
    {
      rolesFor: (tenant) => [{ tenant, name: 'reviewer', grants: [] }],
    },
    { tenant: 'o1', declared: [roles.editor], policy },
  );
});

describe('testReplayStore without claim', () => {
  const store = memoryReplayStore();
  testReplayStore({
    seen: (jti) => store.seen(jti),
    remember: (jti, expiresAt) => store.remember(jti, expiresAt),
  });
});

describe('testApprovalStore across a reopen', () => {
  const store = memoryApprovalStore();
  testApprovalStore(store, { reopen: () => store });
});

describe('testEntitlementSource without expected plans', () => {
  testEntitlementSource(
    {
      entitlementsFor: (_principal, scope) =>
        scope.tenant === undefined ? [] : ['pro'],
    },
    { principal: { id: 'u1' }, tenant: 'o1' },
  );
});

describe('testLimitStore without a synchronous peek', () => {
  const store = memoryLimitStore();
  testLimitStore({
    consume: (input) => store.consume(input),
    remaining: () => undefined,
  });
});

describe('testDecisionSink without flush', () => {
  testDecisionSink({ write: () => undefined });
});

describe('testSnapshotSource with a signed snapshot and a firing subscription', () => {
  testSnapshotSource({
    get: () => 'header.payload.signature',
    subscribe: (listener) => {
      listener();
      return () => undefined;
    },
  });
});

describe('testPolicySource without a policy', () => {
  testPolicySource(memoryPolicySource());
});

function base64url(value: string): string {
  return btoa(value)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

describe('testTokenSigner with a padded header and no jwks', () => {
  let kid = 'k';
  while (
    JSON.stringify({ alg: 'EdDSA', kid, typ: 'permdock-snapshot+jwt' }).length %
      3 ===
    0
  ) {
    kid += 'k';
  }
  const signed = new Set<string>();
  const signer: TokenSigner = {
    sign(payload, options) {
      const token = [
        base64url(JSON.stringify({ alg: 'EdDSA', kid, typ: options.typ })),
        base64url(JSON.stringify(payload)),
        'signature',
      ].join('.');
      signed.add(token);
      return Promise.resolve(token);
    },
  };
  const verifier: TokenVerifier = {
    verify: (token) =>
      Promise.resolve(
        signed.has(token)
          ? {
              ok: true,
              claims: { sub: 'u_1' },
              header: { alg: 'EdDSA', typ: 'permdock-snapshot+jwt' },
            }
          : { ok: false, reason: 'invalid-token', cause: 'invalid-signature' },
      ),
  };
  testTokenSigner(signer, { verifier });
});

function keyEndingInA(): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const key = generateApiKey('key_a');
    if (key.endsWith('A')) {
      return key;
    }
  }
  throw new Error('no key ending in A');
}

describe('testCredentialVerifier on a key ending in A', () => {
  const key = keyEndingInA();
  testCredentialVerifier(
    {
      verify: (candidate) =>
        candidate === key
          ? {
              v: 1,
              id: 'key_a',
              kind: 'user',
              principal: 'u_1',
              permissions: [{ permission: 'repo.read' }],
              createdBy: 'u_1',
              createdAt: 1_700_000_000,
            }
          : null,
    },
    { key },
  );
});

describe('testApprovalStore where the second concurrent consume wins', () => {
  const store = memoryApprovalStore();
  const calls = new Map<string, number>();
  testApprovalStore({
    ...store,
    async consume(token) {
      const call = calls.get(token) ?? 0;
      calls.set(token, call + 1);
      if (call % 2 === 1) {
        await Promise.resolve();
        await Promise.resolve();
      }
      return store.consume(token);
    },
  });
});

describe('testWhereCompiler with a custom fail-closed test', () => {
  testWhereCompiler(() => undefined, { target: {} });
  testWhereCompiler(() => null, { target: {} });
  testWhereCompiler(() => ({ sql: 'false' }), {
    target: {},
    isFailClosed: (compiled) =>
      typeof compiled === 'object' &&
      compiled !== null &&
      'sql' in compiled &&
      compiled.sql === 'false',
  });
});
