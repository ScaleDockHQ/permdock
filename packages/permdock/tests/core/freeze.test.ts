import { describe, expect, it } from 'vitest';

import { freezeDeep, freezeShallow } from '../../src/core/freeze.ts';
import { assertSafeKey, readPath } from '../../src/core/paths.ts';
import {
  anonymousSubject,
  isPrincipal,
  isSubject,
} from '../../src/core/subject.ts';

describe('freeze and paths', () => {
  it('freezes objects deeply and skips maps', () => {
    const value = { nested: { n: 1 }, items: [1] };
    freezeDeep(value);
    expect(Object.isFrozen(value.nested)).toBe(true);
    const map = new Map([['a', 1]]);
    freezeDeep(map);
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.isFrozen(freezeShallow({ a: 1 }))).toBe(true);
  });

  it('reads own paths only', () => {
    expect(readPath({ a: { b: 2 } }, 'a.b')).toBe(2);
    expect(readPath({ a: 1 }, 'constructor')).toBeUndefined();
    expect(() => assertSafeKey('prototype', 'x')).toThrow(/forbidden/);
  });
});

describe('subject guards', () => {
  it('distinguishes principals, subjects and anonymous', () => {
    expect(isPrincipal({ id: 'u1' })).toBe(false);
    expect(isPrincipal({ id: 'u1', roles: ['member'] })).toBe(true);
    expect(isSubject({ principal: { id: 'u1' }, context: {} })).toBe(true);
    expect(isPrincipal({ principal: null, context: {} })).toBe(false);
    expect(anonymousSubject().principal).toBeNull();
  });
});
