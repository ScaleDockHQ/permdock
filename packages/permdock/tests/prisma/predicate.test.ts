import { describe, expect, it } from 'vitest';

import type {
  PrismaCombinators,
  PrismaFieldProxy,
} from '../../src/prisma/predicate.ts';

import { toPredicate } from '../../src/prisma/predicate.ts';

function field(name: string): PrismaFieldProxy {
  const op =
    (kind: string) =>
    (value?: unknown): string =>
      value === undefined
        ? `${name} ${kind}`
        : `${name} ${kind} ${JSON.stringify(value)}`;
  return {
    eq: op('='),
    neq: op('<>'),
    gt: op('>'),
    gte: op('>='),
    lt: op('<'),
    lte: op('<='),
    like: op('like'),
    in: op('in'),
    isNull: op('is null'),
    isNotNull: op('is not null'),
  };
}

const model = new Proxy<Record<string, PrismaFieldProxy>>(
  {},
  {
    get: (_, name) => (typeof name === 'string' ? field(name) : undefined),
  },
);

const combinators: PrismaCombinators = {
  and: (...items) => `(${items.join(' and ')})`,
  or: (...items) => `(${items.join(' or ')})`,
  not: (item) => `not ${String(item)}`,
};

describe('permdock/prisma toPredicate (Prisma 8)', () => {
  it('builds a predicate over the field proxy', () => {
    const predicate = toPredicate(
      {
        op: 'and',
        conditions: [
          { op: 'eq', field: 'orgId', value: 'o1' },
          { op: 'in', field: 'status', value: ['open', 'draft'] },
          { op: 'contains', field: 'title', value: '50%' },
        ],
      },
      { combinators },
    );
    expect(predicate(model)).toBe(
      '(orgId = "o1" and status in ["open","draft"] and title like "%50\\\\%%")',
    );
  });

  it('keeps NULL rows of a negation like the in-memory evaluator', () => {
    const predicate = toPredicate(
      { op: 'not', condition: { op: 'eq', field: 'orgId', value: 'o1' } },
      { combinators },
    );
    expect(predicate(model)).toBe('(not orgId = "o1" or orgId is null)');
  });

  it('matches no row without a grant, spelled on the key', () => {
    expect(
      toPredicate({ op: 'or', conditions: [] }, { combinators })(model),
    ).toBe('id is null');
    expect(
      toPredicate(
        { op: 'or', conditions: [] },
        { combinators, key: 'uuid' },
      )(model),
    ).toBe('uuid is null');
  });

  it('refuses list contains, membership joins and unknown fields', () => {
    expect(() =>
      toPredicate(
        { op: 'contains', field: 'tags', value: 'a' },
        { combinators, model: { required: [], lists: ['tags'] } },
      )(model),
    ).toThrow(/list field 'tags'/);
    expect(() =>
      toPredicate(
        { op: 'eq', field: 'orgId', value: 'o1' },
        { combinators },
      )({}),
    ).toThrow(/no field 'orgId'/);
    expect(() =>
      toPredicate(
        { op: 'eq', field: 'constructor', value: 'x' },
        { combinators },
      )(model),
    ).toThrow(/forbidden/);
  });
});
