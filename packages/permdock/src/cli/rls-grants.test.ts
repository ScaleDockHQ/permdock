import { describe, expect, it } from 'vitest';

import {
  allow,
  anyone,
  authenticated,
  definePermissions,
  definePolicy,
  defineRoles,
  plan,
  relation,
  resource,
  role,
} from '../index.ts';
import { collectGrants, roleNames } from './rls-grants.ts';

const permissions = definePermissions({
  post: resource({
    actions: ['read', 'update'],
    collection: ['list'],
    relations: { author: 'authorId' },
  }),
});
const roles = defineRoles({ owner: {}, auditor: {} });

describe('collectGrants', () => {
  it('collects role grants and top-level grants', () => {
    const policy = definePolicy(
      { permissions, roles },
      {
        subject: () => null,
        roles: [role('editor', [allow(permissions.post.update)])],
        grants: [
          allow(permissions.post.read, { to: roles.owner }),
          allow(permissions.post.list, { to: anyone() }),
          allow(permissions.post.update, {
            to: relation(permissions.post, 'author'),
          }),
          allow(permissions.post.read, { to: authenticated() }),
        ],
      },
    );
    const collected = collectGrants(policy).map((item) => ({
      key: item.grant.permission.key,
      label: item.label,
      access: item.access,
      where: item.where,
    }));
    expect(collected).toEqual([
      {
        key: 'post.update',
        label: 'editor',
        access: { kind: 'role', role: 'editor', scope: 'global' },
        where: undefined,
      },
      {
        key: 'post.read',
        label: 'owner',
        access: { kind: 'role', role: 'owner', scope: 'global' },
        where: undefined,
      },
      {
        key: 'post.list',
        label: 'anyone',
        access: { kind: 'anyone' },
        where: undefined,
      },
      {
        key: 'post.update',
        label: 'authenticated',
        access: { kind: 'authenticated' },
        where: {
          op: 'eq',
          field: 'authorId',
          value: { ref: 'principal.id' },
        },
      },
      {
        key: 'post.read',
        label: 'authenticated',
        access: { kind: 'authenticated' },
        where: undefined,
      },
    ]);
    expect(roleNames(policy).toSorted()).toEqual([
      'auditor',
      'editor',
      'owner',
    ]);
  });

  it('names the permission when a grantee cannot compile to SQL', () => {
    const policy = definePolicy(permissions, {
      subject: () => null,
      grants: [allow(permissions.post.read, { to: plan('pro') })],
    });
    expect(() => collectGrants(policy)).toThrow(/post\.read.*plan grantee/u);
  });
});
