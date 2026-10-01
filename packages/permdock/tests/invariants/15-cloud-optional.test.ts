import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ApprovalRequest,
  type ApprovalStore,
  memoryApprovalStore,
  resumeDecision,
} from '../../src/approvals/index.ts';
import {
  type Decision,
  type DecisionSink,
  createPermDock,
} from '../../src/index.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

const cases = [
  [memberUser, permissions.post.update, ownPost],
  [memberUser, permissions.post.update, otherPost],
  [memberUser, permissions.post.delete, ownPost],
  [adminUser, permissions.post.publish, otherPost],
  [adminUser, permissions.post.publish, ownPost],
] as const;

async function outcomes(sink?: DecisionSink): Promise<string[]> {
  const result: string[] = [];
  for (const [user, leaf, row] of cases) {
    const permdock = await createPermDock(
      policy,
      user,
      sink === undefined ? {} : { sink },
    );
    result.push(permdock.decide(leaf, row).outcome);
  }
  return result;
}

function pending(
  decision: Decision,
): Extract<Decision, { readonly outcome: 'approval-required' }> {
  if (decision.outcome !== 'approval-required') {
    throw new Error(`expected approval-required, got ${decision.outcome}`);
  }
  return decision;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('invariant 15: the Cloud is optional and never on the decision path', () => {
  it('decides with no network access', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.reject(new Error('offline')),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await outcomes()).toEqual([
      'granted',
      'denied',
      'approval-required',
      'denied',
      'granted',
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gives the same outcomes whatever the sink does', async () => {
    const expected = await outcomes();
    const sinks: DecisionSink[] = [
      { write: () => undefined },
      {
        write: () => {
          throw new Error('sink down');
        },
      },
      { write: () => Promise.reject(new Error('sink down')) },
      {
        write: () =>
          new Promise<void>(() => {
            /* never settles */
          }),
      },
    ];
    for (const sink of sinks) {
      expect(await outcomes(sink)).toEqual(expected);
    }
  });

  it('never trusts a stored approval for a token decide did not issue', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const decision = pending(permdock.decide(permissions.post.delete, ownPost));
    const approved = (token: string): ApprovalRequest => ({
      v: 1,
      token,
      permission: 'post.delete',
      scope: 'post:delete',
      resource: { type: 'post', id: 'p1' },
      subject: { principal: { id: 'u1', roles: ['member'] } },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      detail: 'delete post p1',
      status: 'approved',
    });
    const lying: ApprovalStore = {
      ...memoryApprovalStore(),
      get: (token) => approved(token),
      consume: (token) => approved(token),
    };
    const forged = await resumeDecision({
      decision,
      permission: permissions.post.delete,
      subject: permdock.subject,
      store: lying,
      resource: { type: 'post', id: 'p1' },
      adapter: 'test',
      token: 'pd1.forged',
    });
    expect(forged.outcome).toBe('approval-required');
  });

  it('recomputes the token when the row changes before resume', async () => {
    const store = memoryApprovalStore();
    const permdock = await createPermDock(policy, memberUser);
    const first = pending(permdock.decide(permissions.post.delete, ownPost));
    const changed = pending(
      permdock.decide(permissions.post.delete, { ...ownPost, id: 'p7' }),
    );
    expect(changed.token).not.toBe(first.token);
    const resumed = await resumeDecision({
      decision: changed,
      permission: permissions.post.delete,
      subject: permdock.subject,
      store,
      resource: { type: 'post', id: 'p7' },
      adapter: 'test',
      token: first.token,
    });
    expect(resumed.outcome).toBe('approval-required');
  });
});
