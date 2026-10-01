import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { PermissionTree } from '../../src/core/permissions.ts';

import {
  definePermissions,
  expandRelation,
  findPermission,
  getRegistry,
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

describe('definePermissions relation and graph validation', () => {
  const folder = (relations: Record<string, unknown>): PermissionTree =>
    // SAFETY: untyped relation specs, as a JavaScript caller could pass them.
    definePermissions({
      folder: resource({ actions: ['read'], relations: relations as never }),
    });

  it.each<[string, Record<string, unknown>, RegExp]>([
    [
      'a memberOf relation with includes',
      {
        org: { field: 'orgId', memberOf: 'tenant', includes: ['owner'] },
        owner: 'ownerId',
      },
      /cannot include others/u,
    ],
    ['an empty includes', { viewer: { includes: [] } }, /non-empty list/u],
    ['a non-string include', { viewer: { includes: [5] } }, /non-string name/u],
    [
      'an include of an undeclared relation',
      { viewer: { includes: ['ghost'] } },
      /does not declare/u,
    ],
    [
      'an include of a memberOf relation',
      {
        viewer: { includes: ['org'] },
        org: { field: 'orgId', memberOf: 'tenant' },
      },
      /includes the memberOf relation/u,
    ],
    [
      'an include cycle',
      {
        a: { field: 'x', includes: ['b'] },
        b: { field: 'y', includes: ['a'] },
      },
      /form a cycle/u,
    ],
    [
      'an empty edge match',
      { viewer: { edge: 'm', match: {} } },
      /at least one column/u,
    ],
    [
      'a null edge match value',
      { viewer: { edge: 'm', match: { role: null } } },
      /must be a string, a finite number or a boolean/u,
    ],
    [
      'an infinite edge match value',
      { viewer: { edge: 'm', match: { rank: Number.POSITIVE_INFINITY } } },
      /must be a string, a finite number or a boolean/u,
    ],
    [
      'groups without resources',
      { viewer: { edge: 'm', groups: { column: 'kind', resources: {} } } },
      /at least one resource/u,
    ],
    [
      'a group naming no relation',
      {
        viewer: {
          edge: 'm',
          groups: { column: 'kind', resources: { folder: 5 } },
        },
      },
      /must name a relation/u,
    ],
    [
      'a direct value that is also a group resource',
      {
        viewer: {
          edge: 'm',
          groups: {
            column: 'kind',
            resources: { folder: 'viewer' },
            direct: 'folder',
          },
        },
      },
      /is also a group resource/u,
    ],
    [
      'a group of its own resource through another relation',
      {
        viewer: {
          edge: 'm',
          groups: { column: 'kind', resources: { folder: 'editor' } },
        },
        editor: { edge: 'e' },
      },
      /must name the same relation/u,
    ],
    [
      'a group of its own resource that includes others',
      {
        viewer: {
          edge: 'm',
          includes: ['editor'],
          groups: { column: 'kind', resources: { folder: 'viewer' } },
        },
        editor: { edge: 'e' },
      },
      /must name the same relation/u,
    ],
    [
      'a group naming an undeclared relation',
      {
        viewer: {
          edge: 'm',
          groups: { column: 'kind', resources: { team: 'member' } },
        },
      },
      /is not declared/u,
    ],
  ])('rejects %s', (_label, relations, error) => {
    expect(() => folder(relations)).toThrow(error);
  });

  it('accepts finite numeric and boolean match values', () => {
    const tree = folder({
      viewer: { edge: 'm', match: { rank: 2, active: true } },
    });
    expect(getResource(tree, 'folder')?.relations['viewer']).toEqual({
      edge: 'm',
      match: { rank: 2, active: true },
    });
  });

  it('rejects a group naming a memberOf relation, a missing link target and a cross-resource group cycle', () => {
    expect(() =>
      definePermissions({
        team: resource({
          actions: ['read'],
          relations: { org: { field: 'orgId', memberOf: 'tenant' } },
        }),
        folder: resource({
          actions: ['read'],
          relations: {
            viewer: {
              edge: 'm',
              groups: { column: 'kind', resources: { team: 'org' } },
            },
          },
        }),
      }),
    ).toThrow(/names a memberOf relation/u);
    expect(() =>
      definePermissions({
        doc: resource({
          actions: ['read'],
          links: { folder: { field: 'folderId', resource: 'folder' } },
        }),
      }),
    ).toThrow(/undeclared resource 'folder'/u);
    const grouped = (target: string) => ({
      actions: ['read'] as const,
      relations: {
        member: {
          edge: 'members',
          groups: { column: 'kind', resources: { [target]: 'member' } },
        },
      },
    });
    expect(() =>
      definePermissions({
        a: resource(grouped('b')),
        b: resource(grouped('a')),
      }),
    ).toThrow(/cycle across resources/u);
    const shared = definePermissions({
      a: resource(grouped('c')),
      b: resource(grouped('c')),
      c: resource({
        actions: ['read'],
        relations: { member: { edge: 'c_members' } },
      }),
    });
    expect(getResource(shared, 'c')?.name).toBe('c');
  });

  it('expands each included relation once', () => {
    const tree = folder({
      owner: 'ownerId',
      editor: { field: 'editorId', includes: ['owner'] },
      viewer: { includes: ['editor', 'owner'] },
    });
    expect(expandRelation(getResource(tree, 'folder'), 'viewer')).toEqual([
      'editor',
      'owner',
    ]);
    expect(expandRelation(undefined, 'viewer')).toEqual([]);
  });

  it('rejects non-object groups, duplicate resource names and unregistered trees', () => {
    expect(() => definePermissions({ post: 5 })).toThrow(
      /expected a group or resource at 'post'/u,
    );
    expect(() =>
      definePermissions({
        a: { post: resource({ actions: ['read'] }) },
        b: { post: resource({ actions: ['read'] }) },
      }),
    ).toThrow(/duplicate resource name 'post'/u);
    expect(() => getRegistry({})).toThrow(/missing its registry/u);
    // SAFETY: a JavaScript caller passing no arguments.
    const untyped = resource as unknown as () => unknown;
    expect(() => untyped()).toThrow(/requires a schema or options/u);
    expect(() => definePermissions({ post: resource(Post) })).toThrow(
      /no actions/u,
    );
  });

  it('merges a plain tree and rejects a leaf colliding with a group', () => {
    const posts = definePermissions({ post: resource({ actions: ['read'] }) });
    const nested = definePermissions({
      post: { read: resource({ actions: ['view'] }) },
    });
    expect(() => mergePermissions(posts, nested)).toThrow(
      /duplicate permission key 'post.read'/u,
    );
    expect(() => mergePermissions(nested, posts)).toThrow(
      /duplicate permission key 'post.read'/u,
    );
    const leaf = posts.post.read;
    // SAFETY: a hand-built tree without a registry, as a JavaScript caller could pass.
    const plain = { extra: { read: leaf } } as unknown as PermissionTree;
    expect(
      listPermissions(mergePermissions(plain)).map((item) => item.key),
    ).toEqual(['post.read']);
    expect(() => mergePermissions()).toThrow(/at least one tree/u);
  });
});
