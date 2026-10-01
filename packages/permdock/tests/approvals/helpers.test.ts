import { describe, expect, it, vi } from 'vitest';

import type {
  ApprovalRequest,
  ApprovalStore,
} from '../../src/approvals/index.ts';
import type { Decision } from '../../src/core/decision.ts';
import type { Subject } from '../../src/core/subject.ts';

import { storedApprovalToken } from '../../src/approvals/helpers.ts';
import {
  cancelApprovals,
  consumeApproval,
  memoryApprovalStore,
  resumeDecision,
  summariseSubject,
} from '../../src/approvals/index.ts';

const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 1_000).toISOString();

function pending(
  token: string,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    v: 1,
    token,
    permission: 'post.delete',
    scope: 'post:delete',
    resource: { type: 'post', id: '42' },
    subject: { principal: { id: 'u_1', roles: ['member'], tenant: 'o_1' } },
    detail: 'post.delete requires human approval.',
    createdAt: new Date().toISOString(),
    expiresAt: future,
    status: 'pending',
    ...overrides,
  };
}

const requester: Subject = {
  principal: { id: 'u_1', roles: ['member'], tenant: 'o_1' },
  context: {},
};
const anonymous: Subject = { principal: null, context: {} };
const approver: Subject = {
  principal: {
    id: 'u_9',
    roles: [],
    memberships: [{ tenant: 'o_1', roles: ['admin'] }],
  },
  context: {},
};

function required(token: string, staleOnChange = false): Decision {
  // SAFETY: an approval-required decision whose grant carries only the fields the approval code reads.
  return {
    outcome: 'approval-required',
    subject: requester,
    grant: {
      effect: 'allow',
      permission: 'post.delete',
      role: 'member',
      approval: staleOnChange
        ? { by: 'admin', staleOn: 'resource-change' }
        : 'human',
    },
    token,
  } as unknown as Decision;
}

const deletePost = {
  key: 'post.delete',
  scope: 'post:delete',
  resource: 'post',
};

function approved(token: string, overrides: Partial<ApprovalRequest> = {}) {
  const store = memoryApprovalStore();
  store.create(pending(token, overrides));
  store.resolve(token, { status: 'approved', by: approver });
  return store;
}

function resume(input: {
  readonly decision: Decision;
  readonly store: ApprovalStore | undefined;
  readonly token: string | undefined;
  readonly subject?: Subject;
  readonly permission?: typeof deletePost;
  readonly resource?: { readonly type: string; readonly id?: string };
  readonly consume?: boolean;
}) {
  return resumeDecision({
    permission: deletePost,
    subject: requester,
    resource: { type: 'post', id: '42' },
    adapter: 'test',
    ...input,
  });
}

const detailOf = (decision: Decision): unknown =>
  decision.outcome === 'denied'
    ? decision.denials[0]?.detail
    : decision.outcome;

describe('summariseSubject', () => {
  it('keeps an anonymous principal and defaults missing roles', () => {
    expect(summariseSubject(anonymous)).toEqual({ principal: null });
    expect(summariseSubject({ principal: { id: 'u' }, context: {} })).toEqual({
      principal: { id: 'u', roles: [] },
    });
  });
});

describe('resumeDecision edges', () => {
  it('denies a matching token when there is no store', async () => {
    expect(
      detailOf(
        await resume({
          decision: required('t1'),
          store: undefined,
          token: 't1',
        }),
      ),
    ).toBe('approval-not-found');
  });

  it('returns the decision unchanged for a foreign token without a store', async () => {
    expect(
      (
        await resume({
          decision: required('t1'),
          store: undefined,
          token: 'other',
        })
      ).outcome,
    ).toBe('approval-required');
  });

  it.each<[string, Partial<ApprovalRequest>]>([
    ['another permission', { permission: 'post.update' }],
    ['another row', { resource: { type: 'post', id: '7' } }],
  ])('denies a token issued for %s', async (_label, overrides) => {
    const store = approved('t1', overrides);
    expect(
      detailOf(await resume({ decision: required('t1'), store, token: 't1' })),
    ).toBe('approval-mismatch');
  });

  it('denies an approved token presented by an anonymous caller', async () => {
    const store = approved('t1');
    expect(
      detailOf(
        await resume({
          decision: required('t1'),
          store,
          token: 't1',
          subject: anonymous,
        }),
      ),
    ).toBe('approval-mismatch');
  });

  it('does not consume when consume is false', async () => {
    const store = approved('t1');
    expect(
      (
        await resume({
          decision: required('t1'),
          store,
          token: 't1',
          consume: false,
        })
      ).outcome,
    ).toBe('granted');
    expect((await store.get('t1'))?.consumedAt).toBeUndefined();
  });

  it('denies when the store throws while inspecting', async () => {
    const store: ApprovalStore = {
      ...memoryApprovalStore(),
      expire: () => Promise.reject(new Error('down')),
    };
    expect(
      detailOf(await resume({ decision: required('t1'), store, token: 't1' })),
    ).toBe('approval-not-found');
  });

  it('denies a stale token for an earlier version of the row', async () => {
    const store = approved('t-old');
    expect(
      await resume({
        decision: required('t-new', true),
        store,
        token: 't-old',
      }),
    ).toMatchObject({
      outcome: 'denied',
      denials: [{ reason: 'stale-approval' }],
    });
  });

  it('asks again when the stale check cannot match the token', async () => {
    const failing: ApprovalStore = {
      ...approved('t-old'),
      get: () => Promise.reject(new Error('down')),
    };
    expect(
      (
        await resume({
          decision: required('t-new', true),
          store: failing,
          token: 't-old',
        })
      ).outcome,
    ).toBe('approval-required');
    const store = approved('t-old');
    expect(
      (
        await resume({
          decision: required('t-new', true),
          store,
          token: 't-old',
          subject: anonymous,
        })
      ).outcome,
    ).toBe('approval-required');
  });
});

describe('consumeApproval', () => {
  it('reports a store that lost the race to consume', async () => {
    const store: ApprovalStore = { ...approved('t1'), consume: () => null };
    expect(await consumeApproval(store, 't1')).toEqual({
      ok: false,
      detail: 'approval-consumed',
    });
  });
});

describe('cancelApprovals', () => {
  it('uses the store cancel when there is one', async () => {
    const cancel = vi.fn<NonNullable<ApprovalStore['cancel']>>(() => 3);
    const store: ApprovalStore = { ...memoryApprovalStore(), cancel };
    expect(await cancelApprovals(store, { tenant: 'o_1' }, { by: 'ops' })).toBe(
      3,
    );
  });

  it('rejects each pending request as the system when the store has no cancel', async () => {
    const inner = memoryApprovalStore();
    inner.create(pending('a'));
    inner.create(pending('b'));
    inner.create(pending('c'));
    const store: ApprovalStore = {
      create: (record) => inner.create(record),
      get: (token) => inner.get(token),
      list: (query) => inner.list(query),
      expire: (now) => inner.expire(now),
      consume: (token, now) => inner.consume(token, now),
      resolve: (token, verdict) => {
        if (token === 'c') {
          throw new Error('conflict');
        }
        return inner.resolve(token, verdict);
      },
    };
    expect(
      await cancelApprovals(store, {}, { by: 'ops', note: 'offboarding' }),
    ).toBe(2);
    expect(inner.get('a')).toMatchObject({ status: 'rejected' });
    expect(inner.get('c')).toMatchObject({ status: 'pending' });
  });
});

describe('storedApprovalToken', () => {
  it.each<
    [string, Partial<ApprovalRequest> | null, boolean, string | undefined]
  >([
    ['no record', null, false, undefined],
    ['a pending record', {}, false, undefined],
    ['a pending record when pending denies', {}, true, 't1'],
    ['an expired record', { status: 'expired' }, false, undefined],
    [
      'a record past its expiry',
      { status: 'approved', expiresAt: past },
      false,
      undefined,
    ],
    ['an approved record', { status: 'approved' }, false, 't1'],
    ['a rejected record', { status: 'rejected' }, false, 't1'],
  ])('answers %s', async (_label, overrides, denyPending, expected) => {
    const store = memoryApprovalStore();
    if (overrides !== null) {
      store.create(pending('t1', overrides));
    }
    expect(await storedApprovalToken(store, required('t1'), denyPending)).toBe(
      expected,
    );
  });

  it('answers undefined without a store, for another outcome and when the store throws', async () => {
    const failing: ApprovalStore = {
      ...memoryApprovalStore(),
      get: () => Promise.reject(new Error('down')),
    };
    // SAFETY: a denied decision; storedApprovalToken only reads outcome.
    const denied = {
      outcome: 'denied',
      denials: [],
      alternatives: [],
    } as Decision;
    expect([
      await storedApprovalToken(undefined, required('t1'), false),
      await storedApprovalToken(memoryApprovalStore(), denied, false),
      await storedApprovalToken(failing, required('t1'), false),
    ]).toEqual([undefined, undefined, undefined]);
  });
});
