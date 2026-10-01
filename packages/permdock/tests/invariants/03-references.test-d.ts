import { describe, expectTypeOf, it } from 'vitest';

import {
  allow,
  createPermDock,
  deny,
  type Permission,
} from '../../src/index.ts';
import { memberUser, permissions, policy } from '../fixtures/quick-start.ts';

describe('invariant 3: permissions are references, not strings', () => {
  it('refuses a string key where a permission is expected', async () => {
    const permdock = await createPermDock(policy, memberUser);
    // @ts-expect-error a string key is not a permission
    permdock.can('post.read');
    // @ts-expect-error a string key is not a permission
    permdock.decide('post.update');
    // @ts-expect-error a string key is not a permission
    permdock.where('post.read');
    // @ts-expect-error a string key is not a permission
    allow('post.read');
    // @ts-expect-error a string key is not a permission
    deny('post.read');
  });

  it('exposes the key only as a string field of the leaf', () => {
    expectTypeOf(permissions.post.read).toExtend<Permission>();
    expectTypeOf(permissions.post.read.key).toBeString();
    expectTypeOf(permissions.post.read.scope).toBeString();
  });
});
