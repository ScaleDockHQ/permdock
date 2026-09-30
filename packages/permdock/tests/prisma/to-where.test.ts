import { describe, expect, it } from 'vitest';

import type { Subject } from '../../src/core/subject.ts';

import { toWhere, permdockExtension } from '../../src/prisma/to-where.ts';

const subject: Subject = {
  principal: {
    id: 'u1',
    tenant: 'o1',
    memberships: [
      { tenant: 'o1', roles: ['viewer'] },
      { on: { resource: 'document', id: 'd1' }, roles: ['editor'] },
    ],
  },
  context: {},
};

function isEmptyOr(compiled: unknown): boolean {
  return (
    compiled !== null &&
    typeof compiled === 'object' &&
    'OR' in compiled &&
    Array.isArray(compiled.OR) &&
    compiled.OR.length === 0
  );
}

describe('permdock/prisma toWhere', () => {
  it('fails closed on an empty allow set', () => {
    expect(isEmptyOr(toWhere({ op: 'or', conditions: [] }))).toBe(true);
  });

  it('drops null branches on requiredFields and keeps them elsewhere', () => {
    const negated = {
      op: 'not',
      condition: { op: 'eq', field: 'orgId', value: 'acme' },
    } as const;
    expect(toWhere(negated)).toEqual({
      OR: [{ NOT: { orgId: { equals: 'acme' } } }, { orgId: { equals: null } }],
    });
    expect(toWhere(negated, { requiredFields: ['orgId'] })).toEqual({
      NOT: { orgId: { equals: 'acme' } },
    });
    expect(
      toWhere(
        { op: 'notIn', field: 'orgId', value: [] },
        { requiredFields: ['orgId'] },
      ),
    ).toEqual({});
    expect(toWhere({ op: 'notIn', field: 'orgId', value: [] })).toEqual({
      orgId: { not: null },
    });
  });

  it('maps operators and memberOf from frozen memberships', () => {
    expect(toWhere({ op: 'eq', field: 'authorId', value: 'u1' })).toEqual({
      authorId: { equals: 'u1' },
    });
    expect(toWhere({ op: 'contains', field: 'title', value: 'hi' })).toEqual({
      title: { contains: 'hi' },
    });
    expect(
      toWhere({ op: 'contains', field: 'title', value: '100%_a\\b' }),
    ).toEqual({ title: { contains: '100\\%\\_a\\\\b' } });
    expect(
      toWhere(
        { op: 'contains', field: 'tags', value: 'a' },
        { listFields: ['tags'] },
      ),
    ).toEqual({ tags: { has: 'a' } });
    expect(
      toWhere(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        { subject },
      ),
    ).toEqual({ orgId: { equals: 'o1' } });
    expect(toWhere({ op: 'eq', field: '_', value: true })).toEqual({});
  });

  it('rewrites empty OR through permdockExtension', async () => {
    const extension = permdockExtension();
    let seen: Record<string, unknown> | undefined;
    await extension.query.$allModels['findMany']({
      args: { where: { OR: [] } },
      query: async (next) => {
        seen = next;
        return [];
      },
    });
    expect(seen?.['where']).toEqual({
      AND: [{ OR: [] }, { OR: [] }],
      OR: [],
    });
  });
});
