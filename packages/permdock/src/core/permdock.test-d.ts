import { describe, expectTypeOf, it } from 'vitest';

import type { Decision } from './decision.ts';

import {
  permissions,
  policy,
  memberUser,
  ownPost,
} from '../fixtures/quick-start.ts';
import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../index.ts';

describe('permission arity', () => {
  it('requires data for instance actions and allows an optional body for collection', async () => {
    const permdock = await createPermDock(policy, memberUser);
    expectTypeOf(permdock.can).toBeCallableWith(permissions.post.create);
    expectTypeOf(permdock.can).toBeCallableWith(
      permissions.post.create,
      ownPost,
    );
    expectTypeOf(permdock.can).toBeCallableWith(
      permissions.post.update,
      ownPost,
    );
    expectTypeOf(
      allow(permissions.post.create, { check: { authorId: 'u1' } }),
    ).toBeObject();
    // @ts-expect-error collection grants cannot carry `where`
    allow(permissions.post.create, { where: { authorId: 'u1' } });
  });
});

describe('decision exhaustiveness', () => {
  it('narrows Decision.outcome', () => {
    const decision = { outcome: 'granted' } as Decision;
    switch (decision.outcome) {
      case 'granted':
      case 'denied':
      case 'approval-required':
        break;
      default: {
        const exhaustive: never = decision;
        expectTypeOf(exhaustive).toBeNever();
      }
    }
  });
});

describe('identity by key', () => {
  it('uses the key not object identity', () => {
    const copy = definePermissions({
      post: resource({ actions: ['read'], collection: ['list'] }),
    });
    expectTypeOf(copy.post.read.key).toEqualTypeOf<'post.read'>();
    expectTypeOf(permissions.post.update.kind).toEqualTypeOf<'instance'>();
    expectTypeOf(permissions.post.create.kind).toEqualTypeOf<'collection'>();
  });
});

describe('policy subject', () => {
  it('accepts the quick-start policy', () => {
    expectTypeOf(policy).toHaveProperty('fingerprint');
    expectTypeOf(role).parameter(0).toEqualTypeOf<string>();
  });
});
