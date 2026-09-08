import { describe, expect, it } from 'vitest';

import { isSubjectRef, subject } from './refs.ts';

describe('subject refs', () => {
  it('builds prototype-safe paths', () => {
    expect(subject.id.ref).toBe('subject.id');
    expect(subject.context.teamIds.ref).toBe('subject.context.teamIds');
    expect(isSubjectRef(subject.id)).toBe(true);
    expect(() => subject.constructor).toThrow(/forbidden/);
  });
});
