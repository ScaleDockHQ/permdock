import { describe, expect, it, vi } from 'vitest';

import type { Condition } from '../../src/conditions/ast.ts';
import type {
  PrismaCombinators,
  PrismaFieldProxy,
} from '../../src/prisma/predicate.ts';

import { PermDockValidationError } from '../../src/core/errors.ts';
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
    expect(() =>
      toPredicate(
        { op: 'contains', field: 'tags', value: 'a' },
        { combinators, listFields: ['tags'] },
      )(model),
    ).toThrow(/list field 'tags'/);
    expect(() =>
      toPredicate(
        { op: 'contains', field: 'title', value: 5 },
        { combinators },
      )(model),
    ).toThrow(/non-string value on 'title'/);
    expect(() =>
      toPredicate(
        { op: 'eq', field: 'orgId', value: 'o1' },
        { combinators, fields: { orgId: '__proto__' } },
      )(model),
    ).toThrow(/forbidden/);
  });

  const cases: readonly {
    readonly condition: Condition;
    readonly sql: string;
  }[] = [
    { condition: { op: 'gt', field: 'a', value: 1 }, sql: 'a > 1' },
    { condition: { op: 'gte', field: 'a', value: 1 }, sql: 'a >= 1' },
    { condition: { op: 'lt', field: 'a', value: 1 }, sql: 'a < 1' },
    { condition: { op: 'lte', field: 'a', value: 1 }, sql: 'a <= 1' },
    {
      condition: { op: 'notIn', field: 'a', value: ['x', 'y'] },
      sql: 'not a in ["x","y"]',
    },
    {
      condition: { op: 'notIn', field: 'a', value: [] },
      sql: 'a is not null',
    },
    { condition: { op: 'isNull', field: 'a', value: true }, sql: 'a is null' },
    {
      condition: { op: 'isNull', field: 'a', value: false },
      sql: 'a is not null',
    },
    { condition: { op: 'eq', field: '_', value: true }, sql: 'id is not null' },
    {
      condition: {
        op: 'or',
        conditions: [
          { op: 'eq', field: 'a', value: 1 },
          { op: 'eq', field: 'b', value: 2 },
        ],
      },
      sql: '(a = 1 or b = 2)',
    },
  ];

  for (const { condition, sql } of cases) {
    it(`spells ${JSON.stringify(condition)}`, () => {
      expect(toPredicate(condition, { combinators })(model)).toBe(sql);
    });
  }

  it('spells ne and renames fields', () => {
    expect(
      toPredicate(
        { op: 'ne', field: 'orgId', value: 'o1' },
        { combinators, fields: { orgId: 'org_id' } },
      )(model),
    ).toBe('org_id <> "o1"');
    expect(
      toPredicate(
        { op: 'contains', field: 'name', value: 'a_b' },
        { combinators, fields: { name: 'display_name' } },
      )(model),
    ).toBe('display_name like "%a\\\\_b%"');
  });

  it('refuses opaque SQL', () => {
    expect(() =>
      toPredicate(
        { op: 'opaque', sql: 'true', fingerprint: 'f' },
        { combinators },
      ),
    ).toThrow(PermDockValidationError);
  });

  it('loads the Prisma combinators by default and explains a missing install', () => {
    expect(() => toPredicate({ op: 'eq', field: 'a', value: 1 })).toThrow(
      /needs @prisma\/orm-postgres/,
    );
    const spy = vi
      .spyOn(process, 'getBuiltinModule')
      .mockReturnValue(undefined);
    try {
      expect(() => toPredicate({ op: 'eq', field: 'a', value: 1 })).toThrow(
        /pass `combinators` on runtimes without require/,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
