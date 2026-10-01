import { describe, expect, it } from 'vitest';

import type { Policy } from '../../src/index.ts';

import { collectGrants, roleNames } from '../../src/cli/rls-grants.ts';
import {
  actor,
  allow,
  anyone,
  assurance,
  authenticated,
  definePermissions,
  definePolicy,
  defineRoles,
  deny,
  plan,
  relation,
  resource,
  role,
} from '../../src/index.ts';

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

  it('compiles an oauth-client deny and refuses every other actor grantee', () => {
    const denyClients = definePolicy(permissions, {
      subject: () => null,
      grants: [deny(permissions.post.update, { to: actor('oauth-client') })],
    });
    expect(collectGrants(denyClients).map((item) => item.access)).toEqual([
      { kind: 'actor', actor: 'oauth-client' },
    ]);
    expect(collectGrants(denyClients)[0]?.label).toBe('actor');
    const cases = [
      allow(permissions.post.update, { to: actor('oauth-client') }),
      deny(permissions.post.update, { to: actor('agent') }),
      deny(permissions.post.update, {
        to: [actor('oauth-client'), roles.owner],
      }),
    ];
    for (const grant of cases) {
      const policy = definePolicy(
        { permissions, roles },
        { subject: () => null, grants: [grant] },
      );
      expect(() => collectGrants(policy)).toThrow(/actor grantee/u);
    }
  });

  it('refuses assurance grantees and several roles at once', () => {
    const stepUp = definePolicy(permissions, {
      subject: () => null,
      grants: [allow(permissions.post.read, { to: assurance({ acr: 'phr' }) })],
    });
    expect(() => collectGrants(stepUp)).toThrow(/assurance grantee/u);
    const both = definePolicy(
      { permissions, roles },
      {
        subject: () => null,
        grants: [
          allow(permissions.post.read, { to: [roles.owner, roles.auditor] }),
        ],
      },
    );
    expect(() => collectGrants(both)).toThrow(
      /requires several roles at once \(owner, auditor\)/u,
    );
  });

  it('labels a resource-scoped role grant with its role', () => {
    const policy = definePolicy(
      { permissions, roles },
      {
        subject: () => null,
        grants: [
          allow(permissions.post.read, {
            to: { kind: 'role', role: 'owner', scope: { resource: 'post' } },
          }),
        ],
      },
    );
    expect(
      collectGrants(policy).map((item) => [item.label, item.access]),
    ).toEqual([
      ['owner', { kind: 'resource', role: 'owner', resource: 'post' }],
    ]);
    expect(roleNames(policy)).toContain('owner');
  });

  it('names an undeclared relation', () => {
    const policy = definePolicy(permissions, {
      subject: () => null,
      grants: [],
    });
    const grant = allow(permissions.post.read, {
      to: { kind: 'relation', resource: 'post', relation: 'editor' },
    });
    const broken: Policy = {
      ...policy,
      // SAFETY: an allow() grant as definePolicy stores it, without the relation check definePolicy runs.
      grants: [grant] as unknown as Policy['grants'],
    };
    expect(() => collectGrants(broken)).toThrow(
      /names relation 'editor', which post does not declare/u,
    );
  });
});
