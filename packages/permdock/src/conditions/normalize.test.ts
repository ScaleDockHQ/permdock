import { describe, expect, it } from 'vitest';

import { hasConditionOp } from './ast.ts';
import { normalizeWhere } from './normalize.ts';
import { opaque } from './opaque.ts';
import { subject } from './refs.ts';
import { sqlFunction } from './sql-function.ts';

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

  it('accepts sqlFunction with a portable twin and rejects opaque or nested twins', () => {
    expect(
      normalizeWhere({
        op: 'sqlFunction',
        name: 'job_permitted',
        args: [{ field: 'id' }],
        twin: { scope: 'public' },
      }),
    ).toMatchObject({
      op: 'sqlFunction',
      name: 'job_permitted',
      twin: { op: 'eq', field: 'scope', value: 'public' },
    });
    expect(() =>
      normalizeWhere({
        op: 'sqlFunction',
        name: 'job_permitted',
        args: [{ field: 'id' }],
        twin: opaque({ sql: '1=1', fingerprint: 'x' }),
      }),
    ).toThrow(/twin must not be opaque/);
    expect(() =>
      sqlFunction('job_permitted', {
        args: [{ field: 'id' }],
        twin: sqlFunction('other', { twin: { scope: 'public' } }),
      }),
    ).toThrow(/must not nest sqlFunction/);
    expect(() => sqlFunction('a.b.c', { twin: { scope: 'public' } })).toThrow(
      /SQL identifier/,
    );
    expect(() =>
      sqlFunction('job-permitted', { twin: { scope: 'public' } }),
    ).toThrow(/SQL identifier/);
    expect(() =>
      sqlFunction('job_permitted', {
        args: [{ field: 'constructor' }],
        twin: { scope: 'public' },
      }),
    ).toThrow(/forbidden/);
    expect(
      sqlFunction('public.job_permitted', {
        twin: { not: { scope: 'private' } },
      }).twin.op,
    ).toBe('not');
    const node = sqlFunction('job_permitted', {
      args: [{ field: 'id' }],
      twin: { or: [{ scope: 'public' }, { authorId: subject.id }] },
    });
    expect(hasConditionOp(node, 'sqlFunction')).toBe(true);
    expect(hasConditionOp(node, 'or')).toBe(true);
    expect(hasConditionOp(node, 'opaque')).toBe(false);
    expect(hasConditionOp(undefined, 'eq')).toBe(false);
    expect(
      hasConditionOp(normalizeWhere({ not: { published: true } }), 'eq'),
    ).toBe(true);
    expect(
      hasConditionOp(normalizeWhere({ and: [{ a: 1 }, { b: 2 }] }), 'eq'),
    ).toBe(true);
  });

  it('rejects empty objects and forbidden field names', () => {
    expect(() => normalizeWhere({})).toThrow(/empty condition/);
    expect(() => normalizeWhere({ constructor: 'x' })).toThrow(/forbidden/);
  });
});
