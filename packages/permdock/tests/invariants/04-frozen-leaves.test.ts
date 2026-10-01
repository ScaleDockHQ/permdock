import { describe, expect, it } from 'vitest';

import { permissions } from '../fixtures/quick-start.ts';

const leaves = Object.values(permissions.post);

describe('invariant 4: permission leaves are plain frozen JSON', () => {
  it('has exactly the five leaf fields', () => {
    for (const leaf of leaves) {
      expect(Object.keys(leaf).toSorted()).toEqual([
        'action',
        'key',
        'meta',
        'resource',
        'scope',
      ]);
    }
  });

  it('is deeply frozen', () => {
    for (const leaf of leaves) {
      expect(Object.isFrozen(leaf)).toBe(true);
      expect(Object.isFrozen(leaf.meta)).toBe(true);
      expect(() => {
        // SAFETY: deliberately writing a readonly field to prove the freeze.
        (leaf as { key: string }).key = 'forged';
      }).toThrow(TypeError);
    }
  });

  it('is a plain object with no functions, symbols or accessors', () => {
    for (const leaf of leaves) {
      expect(Object.getPrototypeOf(leaf)).toBe(Object.prototype);
      expect(Object.getOwnPropertySymbols(leaf)).toEqual([]);
      for (const descriptor of Object.values(
        Object.getOwnPropertyDescriptors(leaf),
      )) {
        expect(descriptor.get).toBeUndefined();
        expect(typeof descriptor.value).not.toBe('function');
      }
    }
  });

  it('survives structuredClone and a JSON round trip unchanged', () => {
    for (const leaf of leaves) {
      expect(structuredClone(leaf)).toEqual(leaf);
      expect(JSON.parse(JSON.stringify(leaf))).toEqual(leaf);
    }
  });

  it('derives key and scope from resource and action', () => {
    for (const leaf of leaves) {
      expect(leaf.key).toBe(`${leaf.resource}.${leaf.action}`);
      expect(leaf.scope).toBe(`${leaf.resource}:${leaf.action}`);
    }
  });
});
