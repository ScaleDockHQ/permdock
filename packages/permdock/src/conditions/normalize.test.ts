import { describe, expect, it } from 'vitest';

import { normalizeWhere } from './normalize.ts';
import { opaque } from './opaque.ts';
import { subject } from './refs.ts';

describe('normalizeWhere', () => {
  it('turns object shorthand into a tagged AST and flattens compounds', () => {
    const condition = normalizeWhere({
      authorId: subject.id,
      published: { eq: false },
      and: [{ tags: { contains: 'x' } }],
    });
    expect(condition.op).toBe('and');
    if (condition.op !== 'and') {
      return;
    }
    expect(condition.conditions.some((child) => child.op === 'eq')).toBe(true);
  });

  it('collapses a single child and accepts tagged nodes', () => {
    const tagged = normalizeWhere({
      op: 'eq',
      field: 'authorId',
      value: { ref: 'subject.id' },
    });
    expect(tagged).toEqual({
      op: 'eq',
      field: 'authorId',
      value: { ref: 'subject.id' },
    });
    expect(normalizeWhere({ published: { isNull: true } })).toEqual({
      op: 'isNull',
      field: 'published',
      value: true,
    });
  });

  it('normalises in/notIn, dates and opaque sql', () => {
    expect(normalizeWhere({ status: { in: ['open', 'paid'] } }).op).toBe('in');
    expect(
      normalizeWhere({ createdAt: { gt: new Date('2020-01-01T00:00:00Z') } }),
    ).toMatchObject({
      op: 'gt',
      field: 'createdAt',
    });
    expect(
      normalizeWhere(
        opaque({ sql: 'owner_id = auth.uid()', fingerprint: 'abc' }),
      ),
    ).toMatchObject({ op: 'opaque', fingerprint: 'abc' });
  });

  it('rejects empty objects and forbidden field names', () => {
    expect(() => normalizeWhere({})).toThrow(/empty condition/);
    expect(() => normalizeWhere({ constructor: 'x' })).toThrow(/forbidden/);
  });
});
