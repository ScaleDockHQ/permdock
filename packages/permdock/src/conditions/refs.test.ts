import { describe, expect, it } from 'vitest';

import { context, isSubjectRef, principal } from './refs.ts';

describe('condition refs', () => {
  it('builds prototype-safe paths', () => {
    expect(principal.id.ref).toBe('principal.id');
    expect(context.teamIds.ref).toBe('context.teamIds');
    expect(isSubjectRef(principal.id)).toBe(true);
    expect(isSubjectRef({ ref: 'subject.id' })).toBe(false);
    expect(() => principal.constructor).toThrow(/forbidden/);
  });
});
