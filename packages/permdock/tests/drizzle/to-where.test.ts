import { describe, expect, it } from 'vitest';

import type { Subject } from '../../src/core/subject.ts';
import type { DrizzleOperators } from '../../src/drizzle/types.ts';

import { PermDockValidationError } from '../../src/core/errors.ts';
import { toWhere } from '../../src/drizzle/to-where.ts';

function rec(
  op: string,
): (...args: unknown[]) => { op: string; args: unknown[] } {
  return (...args: unknown[]) => ({ op, args });
}

function asNode(compiled: unknown): { op: unknown; args: unknown[] } {
  if (
    compiled === null ||
    typeof compiled !== 'object' ||
    !('op' in compiled) ||
    !('args' in compiled) ||
    !Array.isArray(compiled.args)
  ) {
    throw new Error('not an ops() node');
  }
  return { op: compiled.op, args: compiled.args };
}

function ops(): DrizzleOperators {
  return {
    and: rec('and'),
    or: rec('or'),
    not: rec('not'),
    eq: rec('eq'),
    ne: rec('ne'),
    gt: rec('gt'),
    gte: rec('gte'),
    lt: rec('lt'),
    lte: rec('lte'),
    inArray: rec('inArray'),
    notInArray: rec('notInArray'),
    isNull: rec('isNull'),
    isNotNull: rec('isNotNull'),
    like: rec('like'),
    sql: (strings, ...values) => ({
      op: 'sql',
      args: [strings.join('?'), ...values],
    }),
  };
}

const posts = { authorId: 'col.author', orgId: 'col.org', tags: 'col.tags' };
const subject: Subject = {
  principal: {
    id: 'u1',
    tenant: 'o1',
    memberships: [{ tenant: 'o1', roles: ['viewer'] }],
  },
  context: {},
};

function isSqlFalse(compiled: unknown): boolean {
  return (
    compiled !== null &&
    typeof compiled === 'object' &&
    'op' in compiled &&
    compiled.op === 'sql' &&
    'args' in compiled &&
    Array.isArray(compiled.args) &&
    compiled.args[0] === 'false'
  );
}

describe('permdock/drizzle toWhere', () => {
  it('fails closed on an empty allow set', () => {
    expect(
      isSqlFalse(
        toWhere({ op: 'or', conditions: [] }, posts, { operators: ops() }),
      ),
    ).toBe(true);
  });

  it('maps comparison operators and subject equality', () => {
    expect(
      toWhere({ op: 'eq', field: 'authorId', value: 'u1' }, posts, {
        operators: ops(),
      }),
    ).toEqual({ op: 'eq', args: ['col.author', 'u1'] });
    expect(
      toWhere({ op: 'in', field: 'orgId', value: ['o1', 'o2'] }, posts, {
        operators: ops(),
      }),
    ).toEqual({ op: 'inArray', args: ['col.org', ['o1', 'o2']] });
    expect(
      toWhere({ op: 'contains', field: 'tags', value: 'draft' }, posts, {
        operators: ops(),
      }),
    ).toEqual({ op: 'like', args: ['col.tags', '%draft%'] });
  });

  it('compiles memberOf tenant equality and exists joins', () => {
    expect(
      toWhere(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        posts,
        { operators: ops(), subject },
      ),
    ).toEqual({ op: 'eq', args: ['col.org', 'o1'] });
    const exists = asNode(
      toWhere(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        posts,
        {
          operators: ops(),
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
      ),
    );
    expect(exists.op).toBe('sql');
    expect(String(exists.args[0])).toContain(
      'exists (select 1 from organization_members',
    );
    expect(exists.args).toContain('u1');
  });

  it('escapes LIKE wildcards and matches array columns by element', () => {
    expect(
      toWhere({ op: 'contains', field: 'authorId', value: '100%_a' }, posts, {
        operators: ops(),
      }),
    ).toEqual({ op: 'like', args: ['col.author', '%100\\%\\_a%'] });
    const arrays = { tags: { dataType: 'array' } };
    expect(
      toWhere({ op: 'contains', field: 'tags', value: 'draft' }, arrays, {
        operators: ops(),
      }),
    ).toEqual({ op: 'sql', args: ['? = any(?)', 'draft', arrays.tags] });
  });

  it('binds whole-second expiry and the active tenant in exists joins', () => {
    const exists = asNode(
      toWhere(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        posts,
        {
          operators: ops(),
          subject,
          now: 100.2,
          memberships: {
            tenant: {
              table: 'members',
              user: 'user_id',
              role: 'role',
              tenant: 'org_id',
              expiresAt: 'expires_at',
            },
          },
        },
      ),
    );
    expect(String(exists.args[0])).toContain('expires_at > ?');
    expect(exists.args).toContain(101);
    expect(exists.args).toContain('o1');
    expect(exists.args).toContain('viewer');
  });

  it('throws on unknown columns and non-portable grants', () => {
    expect(() =>
      toWhere({ op: 'eq', field: 'missing', value: 'x' }, posts, {
        operators: ops(),
      }),
    ).toThrow(/unknown column/);
    expect(() =>
      toWhere(
        {
          condition: { op: 'eq', field: 'authorId', value: 'u1' },
          partial: true,
        },
        posts,
        { operators: ops() },
      ),
    ).toThrow(PermDockValidationError);
  });
});
