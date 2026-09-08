import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  definePermissions,
  findPermission,
  getResource,
  listPermissions,
  mergePermissions,
  resource,
} from './permissions.ts';

const Post = z.object({ id: z.string() });

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

  it('rejects forbidden keys, empty resources, root resources and self-parents', () => {
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
    expect(() =>
      definePermissions({
        post: resource({
          actions: ['read'],
          parent: { field: 'parentId', resource: 'post' },
        }),
      }),
    ).toThrow(/cannot parent itself/);
  });

  it('caps group depth at 10', () => {
    let tree: unknown = resource({ actions: ['read'] });
    for (let i = 0; i < 12; i += 1) {
      tree = { g: tree };
    }
    expect(() => definePermissions(tree as never)).toThrow(/nesting exceeds/);
  });
});
