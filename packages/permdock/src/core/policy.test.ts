import { describe, expect, it } from 'vitest';

import { principal } from '../conditions/refs.ts';
import { definePermissions, resource } from './permissions.ts';
import { allow, definePolicy, deny, inferOutput, role } from './policy.ts';

const permissions = definePermissions({
  post: resource({
    actions: ['read', 'update'],
    collection: ['create'],
  }),
  org: resource({ actions: ['delete'] }),
});

describe('policy', () => {
  it('normalises grants, merges role fragments and fingerprints', () => {
    const memberA = role('member', [allow(permissions.post.read)]);
    const memberB = role('member', [
      allow(permissions.post.update, { where: { authorId: principal.id } }),
    ]);
    const policy = definePolicy(permissions, {
      roles: [memberA, memberB],
      subject: () => ({ id: 'u1', roles: ['member'] }),
    });
    const member = policy.rolesByName.get('member');
    expect(member?.grants).toHaveLength(2);
    expect(policy.fingerprint.length).toBeGreaterThan(10);
    const again = definePolicy(permissions, {
      roles: [memberA, memberB],
      subject: () => ({ id: 'u1', roles: ['member'] }),
    });
    expect(again.fingerprint).toBe(policy.fingerprint);
  });

  it('rejects where on collection actions and unknown parents', () => {
    expect(() =>
      allow(permissions.post.create, { where: { authorId: 'u1' } as never }),
    ).toThrow(/where is not allowed/);
    const dangling = definePermissions({
      comment: resource({
        actions: ['read'],
        parent: { field: 'postId', resource: 'missing' },
      }),
    });
    expect(() =>
      definePolicy(dangling, {
        roles: [role('member', [allow(dangling.comment.read)])],
        subject: () => ({ id: 'u1' }),
      }),
    ).toThrow(/unknown resource/);
  });

  it('requires scopes.tenant for on: tenant roles', () => {
    expect(() =>
      definePolicy(permissions, {
        roles: [
          role('viewer', [allow(permissions.post.read)], { on: 'tenant' }),
        ],
        subject: () => ({ id: 'u1' }),
      }),
    ).toThrow(/scopes.tenant/);
  });

  it('denies override allows when both exist', () => {
    const policy = definePolicy(permissions, {
      roles: [
        role('admin', [
          allow(permissions.post.update),
          deny(permissions.post.update, { where: { authorId: 'blocked' } }),
        ]),
      ],
      subject: (user: { readonly id: string }) => ({
        id: user.id,
        roles: ['admin'],
      }),
    });
    expect(policy.roles[0]?.grants.map((grant) => grant.effect)).toEqual([
      'allow',
      'deny',
    ]);
  });

  it('exposes inferOutput as a typing helper', () => {
    expect(inferOutput(undefined)).toBeUndefined();
  });
});
