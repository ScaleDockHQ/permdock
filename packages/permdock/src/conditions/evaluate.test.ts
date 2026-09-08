import { describe, expect, it } from 'vitest';

import type { Subject } from '../core/subject.ts';

import { evaluateCondition } from './evaluate.ts';
import { normalizeWhere } from './normalize.ts';
import { opaque } from './opaque.ts';
import { subject } from './refs.ts';

const now = 1_700_000_000;

function sub(
  overrides: Partial<Subject> & { readonly principal?: Subject['principal'] },
): Subject {
  return {
    principal: overrides.principal ?? { id: 'u1', roles: ['member'] },
    context: overrides.context ?? {},
    actor: overrides.actor,
    delegation: overrides.delegation,
  };
}

describe('evaluateCondition', () => {
  it('compares, contains, in/notIn and isNull, failing closed on missing values', () => {
    const data = { authorId: 'u1', tags: ['a'], title: 'hello', gone: null };
    expect(
      evaluateCondition(
        normalizeWhere({ authorId: subject.id }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ authorId: 'nope' }),
        data,
        sub({}),
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        normalizeWhere({ title: { contains: 'ell' } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ tags: { contains: 'a' } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ authorId: { in: ['u1', 'u2'] } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ authorId: { notIn: ['u9'] } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ gone: { isNull: true } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ missing: { eq: 'x' } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        normalizeWhere({ missing: { notIn: ['x'] } }),
        data,
        sub({}),
        now,
      ),
    ).toBe(false);
  });

  it('compares dates by instant', () => {
    const data = { createdAt: '2020-01-02T00:00:00.000Z' };
    expect(
      evaluateCondition(
        normalizeWhere({
          createdAt: { gt: { date: '2020-01-01T00:00:00.000Z' } },
        }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
  });

  it('evaluates and/or/not and never matches opaque', () => {
    const data = { a: 1, b: 2 };
    expect(
      evaluateCondition(
        normalizeWhere({ and: [{ a: 1 }, { b: 2 }] }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        normalizeWhere({ or: [{ a: 9 }, { b: 2 }] }),
        data,
        sub({}),
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(normalizeWhere({ not: { a: 1 } }), data, sub({}), now),
    ).toBe(false);
    expect(
      evaluateCondition(
        opaque({ sql: '1=1', fingerprint: 'x' }),
        data,
        sub({}),
        now,
      ),
    ).toBe(false);
  });

  it('matches memberOf over frozen memberships honouring expiry', () => {
    const data = { orgId: 'o1', teamId: 't1', id: 'd1', folderId: 'f1' };
    const member = sub({
      principal: {
        id: 'u1',
        tenant: 'o1',
        memberships: [
          { tenant: 'o1', roles: ['viewer'] },
          { tenant: 'o1', team: 't1', roles: ['lead'] },
          { on: { resource: 'document', id: 'd1' }, roles: ['editor'] },
          { tenant: 'old', roles: ['viewer'], expiresAt: now - 10 },
        ],
      },
    });
    expect(
      evaluateCondition(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        data,
        member,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'memberOf', scope: 'team', field: 'teamId', roles: ['lead'] },
        data,
        member,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          op: 'memberOf',
          scope: 'resource',
          field: 'id',
          roles: ['editor'],
          resource: 'document',
        },
        data,
        member,
        now,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { op: 'memberOf', scope: 'tenant', field: 'orgId', roles: ['viewer'] },
        { orgId: 'old' },
        member,
        now,
      ),
    ).toBe(false);
  });

  it('does not traverse prototype keys', () => {
    const data = JSON.parse('{"authorId":"u1"}') as object;
    expect(
      evaluateCondition(
        { op: 'eq', field: 'constructor', value: 'Function' },
        data,
        sub({}),
        now,
      ),
    ).toBe(false);
  });
});
