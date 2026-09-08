import { describe, expect, it } from 'vitest';

import type { Subject } from '../core/subject.ts';
import type { KyselyExpressionBuilder, KyselySelectQuery } from './types.ts';

import { toWhere, withSubject } from './to-where.ts';

function selectQuery(table: string): KyselySelectQuery {
  const query = {
    table,
    parts: [] as unknown[],
    select(expr: unknown) {
      query.parts.push({ select: expr });
      return query;
    },
    where(column: string, op: string, value: unknown) {
      query.parts.push({ where: [column, op, value] });
      return query;
    },
    whereRef(left: string, op: string, right: string) {
      query.parts.push({ whereRef: [left, op, right] });
      return query;
    },
  };
  return query;
}

function bin(
  left: unknown,
  op: string,
  right: unknown,
): {
  readonly kind: 'bin';
  readonly left: unknown;
  readonly op: string;
  readonly right: unknown;
} {
  return { kind: 'bin', left, op, right };
}

function eb(): KyselyExpressionBuilder {
  return Object.assign(bin, {
    and: (args: readonly unknown[]) => ({ kind: 'and', args }),
    or: (args: readonly unknown[]) => ({ kind: 'or', args }),
    not: (value: unknown) => ({ kind: 'not', value }),
    lit: (value: unknown) => ({ kind: 'lit', value }),
    val: (value: unknown) => ({ kind: 'val', value }),
    ref: (column: string) => ({ kind: 'ref', column }),
    exists: (query: unknown) => ({ kind: 'exists', query }),
    selectFrom: (table: string) => selectQuery(table),
  });
}

function isLitFalse(compiled: unknown): boolean {
  if (typeof compiled !== 'function') {
    return false;
  }
  const result = compiled(eb()) as { kind?: string; value?: unknown };
  return result.kind === 'lit' && result.value === false;
}

const subject: Subject = {
  principal: {
    id: 'u1',
    tenant: 'o1',
    memberships: [{ tenant: 'o1', roles: ['viewer'] }],
  },
  context: {},
};

describe('permdock/kysely toWhere', () => {
  it('fails closed on an empty allow set', () => {
    expect(isLitFalse(toWhere({ op: 'or', conditions: [] }, 'posts'))).toBe(
      true,
    );
  });

  it('maps operators and memberOf tenant equality', () => {
    expect(
      toWhere({ op: 'eq', field: 'authorId', value: 'u1' }, 'posts')(eb()),
    ).toEqual({
      kind: 'bin',
      left: { kind: 'ref', column: 'posts.authorId' },
      op: '=',
      right: { kind: 'val', value: 'u1' },
    });
    expect(
      toWhere(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        'posts',
        { subject },
      )(eb()),
    ).toEqual({
      kind: 'bin',
      left: { kind: 'ref', column: 'posts.orgId' },
      op: '=',
      right: { kind: 'val', value: 'o1' },
    });
  });

  it('emits exists when a memberships mapping and builder support it', () => {
    const compiled = toWhere(
      { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
      'posts',
      {
        subject,
        memberships: {
          tenant: {
            table: 'organization_members',
            user: 'user_id',
            role: 'role',
            tenant: 'organization_id',
          },
        },
      },
    )(eb()) as { kind: string; query: { table: string } };
    expect(compiled.kind).toBe('exists');
    expect(compiled.query.table).toBe('organization_members as m');
  });

  it('sets session claims inside withSubject', async () => {
    const queries: { sql: string; parameters: readonly unknown[] }[] = [];
    const db = {
      transaction() {
        return {
          execute<T>(fn: (trx: unknown) => Promise<T>): Promise<T> {
            return fn({
              executeQuery(query: {
                readonly sql: string;
                readonly parameters: readonly unknown[];
              }) {
                queries.push(query);
                return Promise.resolve();
              },
            });
          },
        };
      },
    };
    const result = await withSubject(
      db,
      {
        snapshot: () => ({
          v: 2,
          issuedAt: 1,
          subject: {
            principal: { id: 'u1', roles: [], tenant: 'o1' },
            context: {},
          },
          roles: [],
          grants: [],
          tenants: [],
        }),
      },
      async () => 'ok',
    );
    expect(result).toBe('ok');
    expect(queries[0]?.sql).toContain('request.jwt.claims');
    expect(queries[0]?.parameters[0]).toContain('u1');
  });
});
