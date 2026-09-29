import { describe, expect, it } from 'vitest';

import { principal } from '../conditions/refs.ts';
import { assurance } from './grantee.ts';
import { definePermissions, resource } from './permissions.ts';
import {
  allow,
  definePolicy,
  deny,
  inferOutput,
  normalizeApproval,
  requiresApproval,
  role,
  separationConflicts,
} from './policy.ts';
import { defineRoles } from './vocabulary.ts';

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
    ).toThrow(/must declare 'tenant'/);
  });

  it('keeps the on option of a role leaf on its grants', () => {
    const roles = defineRoles({ editor: {} });
    const binding = role(
      roles.editor,
      [allow(permissions.post.update, { to: roles.editor })],
      { on: permissions.post },
    );
    expect(binding.grants[0]?.scope).toEqual({ resource: 'post' });
    expect(binding.grants[0]?.to).toEqual({
      kind: 'role',
      role: 'editor',
      scope: { resource: 'post' },
    });
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

  it('normalises approval.by and treats any defined approval as required', () => {
    expect(normalizeApproval('human')).toBe('human');
    expect(normalizeApproval({ distinct: true })).toEqual({
      by: { kind: 'authenticated' },
      distinct: true,
    });
    expect(normalizeApproval({})).toBe('human');
    expect(normalizeApproval({ distinct: false })).toEqual({
      by: { kind: 'authenticated' },
      distinct: false,
    });
    expect(normalizeApproval({ by: 'admin', distinct: false })).toEqual({
      by: { kind: 'role', role: 'admin', scope: 'global' },
      distinct: false,
    });
    const grant = allow(permissions.org.delete, {
      approval: { by: ['admin', assurance({ amr: 'mfa' })], distinct: true },
    });
    const single = Array.isArray(grant) ? grant[0] : grant;
    expect(requiresApproval(single?.approval)).toBe(true);
    expect(single?.approval).toEqual({
      by: [
        { kind: 'role', role: 'admin', scope: 'global' },
        { kind: 'assurance', amr: ['mfa'] },
      ],
      distinct: true,
    });
  });

  it('records exclusiveWith and reports membership conflicts', () => {
    const policy = definePolicy(permissions, {
      roles: [
        role('preparer', [allow(permissions.post.read)], {
          exclusiveWith: ['approver'],
        }),
        role('approver', [allow(permissions.post.update)]),
      ],
      subject: () => ({ id: 'u1' }),
    });
    expect(policy.rolesByName.get('preparer')?.exclusiveWith).toEqual([
      'approver',
    ]);
    expect(
      separationConflicts(policy, [
        { principal: 'u1', roles: ['preparer', 'approver'] },
      ]),
    ).toEqual([{ principal: 'u1', roles: ['approver', 'preparer'] }]);
  });

  it('exposes inferOutput as a typing helper', () => {
    expect(inferOutput(undefined)).toBeUndefined();
  });
});
