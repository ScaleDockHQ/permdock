import { describe } from 'vitest';

import { toWhere as drizzleToWhere } from '../../src/drizzle/index.ts';
import { toWhere as kyselyToWhere } from '../../src/kysely/index.ts';
import { toWhere as prismaToWhere } from '../../src/prisma/index.ts';
import { testWhereCompiler } from '../../src/testing/conformance.ts';

describe('testWhereCompiler drizzle', () => {
  const posts = { authorId: 'author_id', orgId: 'org_id' };
  testWhereCompiler(
    (condition, table) =>
      drizzleToWhere(condition, table, {
        operators: {
          and: (...args: unknown[]) => ({ op: 'and', args }),
          or: (...args: unknown[]) => ({ op: 'or', args }),
          not: (value: unknown) => ({ op: 'not', value }),
          eq: (column: unknown, value: unknown) => ({
            op: 'eq',
            column,
            value,
          }),
          ne: (column: unknown, value: unknown) => ({
            op: 'ne',
            column,
            value,
          }),
          gt: (column: unknown, value: unknown) => ({
            op: 'gt',
            column,
            value,
          }),
          gte: (column: unknown, value: unknown) => ({
            op: 'gte',
            column,
            value,
          }),
          lt: (column: unknown, value: unknown) => ({
            op: 'lt',
            column,
            value,
          }),
          lte: (column: unknown, value: unknown) => ({
            op: 'lte',
            column,
            value,
          }),
          inArray: (column: unknown, values: readonly unknown[]) => ({
            op: 'inArray',
            column,
            values,
          }),
          notInArray: (column: unknown, values: readonly unknown[]) => ({
            op: 'notInArray',
            column,
            values,
          }),
          isNull: (column: unknown) => ({ op: 'isNull', column }),
          isNotNull: (column: unknown) => ({ op: 'isNotNull', column }),
          like: (column: unknown, value: unknown) => ({
            op: 'like',
            column,
            value,
          }),
          sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
            op: 'sql',
            sql: strings.join('?'),
            values,
          }),
        },
      }),
    {
      target: posts,
      isFailClosed: (compiled) =>
        compiled !== null &&
        typeof compiled === 'object' &&
        'op' in compiled &&
        compiled.op === 'sql' &&
        'sql' in compiled &&
        compiled.sql === 'false',
    },
  );
});

describe('testWhereCompiler prisma', () => {
  testWhereCompiler((condition) => prismaToWhere(condition), {
    target: {},
    isFailClosed: (compiled) =>
      compiled !== null &&
      typeof compiled === 'object' &&
      'OR' in compiled &&
      Array.isArray(compiled.OR) &&
      compiled.OR.length === 0,
  });
});

describe('testWhereCompiler kysely', () => {
  testWhereCompiler((condition, table) => kyselyToWhere(condition, table), {
    target: 'posts',
    isFailClosed: (compiled) => {
      if (typeof compiled !== 'function') {
        return false;
      }
      // SAFETY: the stub lit() above returns { lit }, the shape a fail-closed Kysely where yields.
      const result = compiled({
        and: (args: readonly unknown[]) => args,
        or: (args: readonly unknown[]) => args,
        not: (value: unknown) => value,
        lit: (value: unknown) => ({ lit: value }),
        val: (value: unknown) => value,
        ref: (column: string) => column,
      }) as { lit?: unknown };
      return result.lit === false;
    },
  });
});
