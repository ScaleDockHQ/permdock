import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  definePermissions,
  findPermission,
  getResource,
  isPermission,
  listPermissions,
  mergePermissions,
  resource,
} from '../../src/core/permissions.ts';

const Post = z.object({ id: z.string() });

describe('isPermission', () => {
  const permissions = definePermissions({
    post: resource(Post, {
      id: 'id',
      actions: ['read'],
      collection: ['create'],
    }),
  });

  it('accepts a leaf and a leaf that crossed JSON', () => {
    expect(isPermission(permissions.post.read)).toBe(true);
    expect(isPermission(permissions.post.create)).toBe(true);
    const wire: unknown = JSON.parse(JSON.stringify(permissions.post.read));
    expect(isPermission(wire)).toBe(true);
  });

  it('refuses trees, arrays and partial or malformed leaves', () => {
    const leaf = {
      key: 'post.read',
      scope: 'post:read',
      resource: 'post',
      action: 'read',
      meta: {},
    };
    expect(isPermission(permissions.post)).toBe(false);
    expect(isPermission(permissions)).toBe(false);
    expect(isPermission([permissions.post.read])).toBe(false);
    expect(isPermission(null)).toBe(false);
    expect(isPermission('post.read')).toBe(false);
    expect(isPermission({ ...leaf, meta: undefined })).toBe(false);
    expect(isPermission({ ...leaf, meta: [] })).toBe(false);
    expect(isPermission({ ...leaf, key: 1 })).toBe(false);
    expect(isPermission({ ...leaf, kind: 'other' })).toBe(false);
    expect(isPermission({ ...leaf, kind: 'instance' })).toBe(true);
    expect(isPermission(Object.create(leaf))).toBe(false);
  });
});

describe('permissions', () => {
  it('materialises frozen leaves with dotted keys and colon scopes', () => {
    const permissions = definePermissions({
      post: resource(Post, {
        id: 'id',
        actions: ['read', 'update'],
        collection: ['create'],
      }),
    });
    expect(permissions.post.read.key).toBe('post.read');
    expect(permissions.post.read.scope).toBe('post:read');
    expect(permissions.post.read.resource).toBe('post');
    expect(permissions.post.create.kind).toBe('collection');
    expect(permissions.post.read.kind).toBe('instance');
    expect(JSON.stringify(permissions.post.read)).not.toContain('"kind"');
    expect(Object.isFrozen(permissions.post.read)).toBe(true);
    expect(getResource(permissions, 'post')?.id).toBe('id');
  });

  it('finds by key or scope and lists every leaf', () => {
    const permissions = definePermissions({
      billing: {
        invoice: resource({ actions: ['pay'], collection: ['list'] }),
      },
    });
    expect(findPermission(permissions, 'billing.invoice.pay')?.action).toBe(
      'pay',
    );
    expect(findPermission(permissions, 'billing:invoice:list')?.kind).toBe(
      'collection',
    );
    expect(
      listPermissions(permissions)
        .map((leaf) => leaf.key)
        .toSorted(),
    ).toEqual(['billing.invoice.list', 'billing.invoice.pay']);
  });

  it('merges trees and rejects duplicate keys and resource names', () => {
    const posts = definePermissions({
      post: resource({ actions: ['read'] }),
    });
    const billing = definePermissions({
      billing: resource({ actions: ['pay'] }),
    });
    const merged = mergePermissions(posts, billing);
    expect(listPermissions(merged)).toHaveLength(2);
    expect(() => mergePermissions(posts, posts)).toThrow(
      /duplicate permission key/,
    );
  });

  it('rejects forbidden keys, empty resources and root resources', () => {
    expect(() =>
      definePermissions({
        constructor: resource({ actions: ['read'] }),
      }),
    ).toThrow(/forbidden/);
    expect(() => definePermissions({ post: resource({}) })).toThrow(
      /no actions/,
    );
    expect(() => definePermissions(resource({ actions: ['read'] }))).toThrow(
      /cannot be the root/,
    );
  });

  it('accepts a self-parent and checks relation shapes', () => {
    const tree = definePermissions({
      folder: resource({
        actions: ['read'],
        parent: { field: 'parentId', resource: 'folder' },
        restricted: 'restricted',
        relations: {
          viewer: { edge: 'folder_viewers', expiresAt: 'expires_at' },
          owner: 'ownerId',
        },
      }),
    });
    const node = getResource(tree, 'folder');
    expect(node?.parent).toEqual({ field: 'parentId', resource: 'folder' });
    expect(node?.restricted).toBe('restricted');
    expect(node?.relations['viewer']).toEqual({
      edge: 'folder_viewers',
      expiresAt: 'expires_at',
    });
    expect(() =>
      definePermissions({
        folder: resource({
          actions: ['read'],
          relations: {
            // SAFETY: a deliberately mixed edge and field relation, which must be refused.
            viewer: { edge: 'folder_viewers', field: 'x' } as never,
          },
        }),
      }),
    ).toThrow(/exactly one of field, edge, principal or includes/);
    expect(() =>
      definePermissions({
        folder: resource({
          actions: ['read'],
          relations: { viewer: { edge: 'viewers; drop table x' } },
        }),
      }),
    ).toThrow(/unsafe edge table/);
    expect(() =>
      definePermissions({
        folder: resource({ actions: ['read'], restricted: '__proto__' }),
      }),
    ).toThrow(/forbidden/);
  });

  it('caps group depth at 10', () => {
    let tree: unknown = resource({ actions: ['read'] });
    for (let i = 0; i < 12; i += 1) {
      tree = { g: tree };
    }
    // SAFETY: a deliberately over-deep tree built above, which the type would reject.
    expect(() => definePermissions(tree as never)).toThrow(/nesting exceeds/);
  });
});
