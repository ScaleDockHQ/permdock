import { describe, expect, it } from 'vitest';

import type * as fixture from '../fixtures/quick-start.ts';

import {
  type Decision,
  type Permission,
  createPermDock,
} from '../../src/index.ts';
import { reasonOf } from '../fixtures/decisions.ts';
import {
  adminUser,
  memberUser,
  ownPost,
  otherPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

describe('invariant 5: identity is by key', () => {
  it('decides a cloned leaf like the original', async () => {
    const permdock = await createPermDock(policy, memberUser);
    // SAFETY: decide's overloads share one implementation that takes any leaf with or without a row.
    const decide = permdock.decide as (
      leaf: Permission,
      row?: unknown,
    ) => Decision;
    for (const leaf of Object.values(permissions.post)) {
      const copy = structuredClone(leaf);
      expect(copy).not.toBe(leaf);
      for (const row of [undefined, ownPost, otherPost]) {
        const cloned = decide(copy, row);
        const original = decide(leaf, row);
        expect({ outcome: cloned.outcome, reason: reasonOf(cloned) }).toEqual({
          outcome: original.outcome,
          reason: reasonOf(original),
        });
      }
    }
  });

  it('decides a leaf from a second module copy of the catalogue', async () => {
    // SAFETY: a second evaluation of the same fixture module has its exports.
    const copy = (await import(
      new URL('../fixtures/quick-start.ts?copy', import.meta.url).href
    )) as typeof fixture;
    expect(copy.permissions.post.update).not.toBe(permissions.post.update);
    const permdock = await createPermDock(policy, adminUser);
    expect(permdock.can(copy.permissions.post.update, otherPost)).toBe(true);
    const fromCopy = await createPermDock(copy.policy, memberUser);
    expect(fromCopy.can(permissions.post.update, ownPost)).toBe(true);
    expect(fromCopy.can(permissions.post.update, otherPost)).toBe(false);
  });

  it('resolves a leaf that crossed the wire by its key', async () => {
    const permdock = await createPermDock(policy, adminUser);
    // SAFETY: a JSON round trip keeps every field of the leaf.
    const wire = JSON.parse(
      JSON.stringify(permissions.post.read),
    ) as typeof permissions.post.read;
    expect(permdock.can(wire, ownPost)).toBe(true);
    expect(
      permdock.can({ ...permissions.post.read, key: 'post.nope' }, ownPost),
    ).toBe(false);
  });

  it('keys snapshot grants by key', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error('expected a JSON snapshot');
    }
    expect(JSON.stringify(snapshot)).toContain('"post.update"');
  });
});
