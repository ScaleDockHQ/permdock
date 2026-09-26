import { describe, expect, it } from 'vitest';

import type { Decision } from '../core/decision.ts';
import type { Subject } from '../core/subject.ts';
import type { ApprovalRequest } from './index.ts';

import { decisionToken } from '../core/token.ts';
import {
  ApprovalError,
  approvalsHandler,
  isApprovalError,
  consumeApproval,
  inspectApproval,
  memoryApprovalStore,
  resolveApproval,
  resumeDecision,
} from './index.ts';

const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function pending(
  token: string,
  tenant: string | undefined,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    v: 2,
    token,
    permission: 'post.delete',
    scope: 'post:delete',
    resource: { type: 'post', id: '42' },
    subject: {
      principal:
        tenant === undefined
          ? { id: 'u_1', roles: ['member'] }
          : { id: 'u_1', roles: ['member'], tenant },
    },
    detail: 'post.delete requires human approval.',
    createdAt: new Date().toISOString(),
    expiresAt: future,
    status: 'pending',
    ...overrides,
  };
}

function approver(id: string, tenants: readonly string[]): Subject {
  return {
    principal: {
      id,
      roles: [],
      memberships: tenants.map((tenant) => ({ tenant, roles: ['admin'] })),
    },
    context: {},
  };
}

const requester: Subject = {
  principal: { id: 'u_1', roles: ['member'], tenant: 'o_1' },
  context: {},
};

const grant = {
  effect: 'allow',
  permission: 'post.delete',
  role: 'member',
  approval: 'human',
} as never;

function required(token: string): Decision {
  return {
    outcome: 'approval-required',
    subject: requester,
    grant,
    token,
  } as Decision;
}

const deletePost = {
  key: 'post.delete',
  scope: 'post:delete',
  resource: 'post',
};

describe('single-use approvals', () => {
  it('consumes an approved request exactly once', async () => {
    const store = memoryApprovalStore();
    store.create(pending('pd1.a', 'o_1'));
    expect(store.consume('pd1.a')).toBeNull();
    store.resolve('pd1.a', {
      status: 'approved',
      by: approver('u_9', ['o_1']),
    });
    const first = await consumeApproval(store, 'pd1.a');
    expect(first.ok).toBe(true);
    const second = await consumeApproval(store, 'pd1.a');
    expect(second).toEqual({ ok: false, detail: 'approval-consumed' });
    expect(await inspectApproval(store, 'pd1.a')).toEqual({
      ok: false,
      detail: 'approval-consumed',
    });
  });

  it('keeps a consumed request when the same call asks again', () => {
    const store = memoryApprovalStore();
    store.create(pending('pd1.a', 'o_1'));
    store.resolve('pd1.a', {
      status: 'approved',
      by: approver('u_9', ['o_1']),
    });
    store.consume('pd1.a');
    store.create(pending('pd1.a', 'o_1'));
    expect(store.get('pd1.a')?.consumedAt).toBeDefined();
  });

  it('grants a resume once, then denies the replay', async () => {
    const store = memoryApprovalStore();
    const decision = required('pd1.b');
    const resume = (token: string | undefined) =>
      resumeDecision({
        decision,
        permission: deletePost,
        subject: requester,
        store,
        resource: { type: 'post', id: '42' },
        adapter: 'test',
        token,
      });
    expect((await resume(undefined)).outcome).toBe('approval-required');
    await resolveApproval(store, 'pd1.b', {
      status: 'approved',
      by: approver('u_9', ['o_1']),
    });
    expect((await resume('pd1.b')).outcome).toBe('granted');
    const replay = await resume('pd1.b');
    expect(replay).toMatchObject({
      outcome: 'denied',
      denials: [{ reason: 'approval', detail: 'approval-consumed' }],
    });
  });

  it('ignores a resume token on a decision that needs no approval', async () => {
    const store = memoryApprovalStore();
    const granted = {
      outcome: 'granted',
      subject: requester,
      matched: grant,
      token: 'pd1.c',
    } as Decision;
    const result = await resumeDecision({
      decision: granted,
      permission: deletePost,
      subject: requester,
      store,
      resource: { type: 'post', id: '42' },
      adapter: 'test',
      token: 'pd1.stale',
    });
    expect(result).toBe(granted);
  });

  it('treats a token issued for another call as no resume', async () => {
    const store = memoryApprovalStore();
    store.create(pending('pd1.other', 'o_1'));
    store.resolve('pd1.other', {
      status: 'approved',
      by: approver('u_9', ['o_1']),
    });
    const result = await resumeDecision({
      decision: required('pd1.mine'),
      permission: deletePost,
      subject: requester,
      store,
      resource: { type: 'post', id: '42' },
      adapter: 'test',
      token: 'pd1.other',
    });
    expect(result.outcome).toBe('approval-required');
    expect(store.get('pd1.other')?.consumedAt).toBeUndefined();
    expect(store.get('pd1.mine')?.status).toBe('pending');
  });

  it('denies a resume when the store cannot consume', async () => {
    const inner = memoryApprovalStore();
    inner.create(pending('pd1.d', 'o_1'));
    inner.resolve('pd1.d', {
      status: 'approved',
      by: approver('u_9', ['o_1']),
    });
    const legacy = Object.fromEntries(
      Object.entries(inner).filter(([key]) => key !== 'consume'),
    );
    const result = await resumeDecision({
      decision: required('pd1.d'),
      permission: deletePost,
      subject: requester,
      store: legacy as never,
      resource: { type: 'post', id: '42' },
      adapter: 'test',
      token: 'pd1.d',
    });
    expect(result.outcome).toBe('denied');
  });
});

describe('approval errors', () => {
  it('recognises an approval error from another copy of the module', () => {
    const foreign = Object.assign(new Error('approval is not pending'), {
      name: 'ApprovalError',
      code: 'approval-not-pending',
    });
    expect(isApprovalError(foreign)).toBe(true);
    expect(isApprovalError(new ApprovalError('approval-expired', 'x'))).toBe(
      true,
    );
    expect(
      isApprovalError(
        Object.assign(new Error('x'), { name: 'ApprovalError', code: 'nope' }),
      ),
    ).toBe(false);
    expect(
      isApprovalError({ name: 'ApprovalError', code: 'approval-expired' }),
    ).toBe(false);
  });
});

describe('memory store retention', () => {
  it('drops settled records one ttl after they expire', () => {
    const store = memoryApprovalStore({ ttl: 1000 });
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    store.create(pending('pd1.old', 'o_1', { expiresAt }));
    store.create(pending('pd1.new', 'o_1'));
    const later = new Date(Date.now() + 1500);
    expect(store.expire(later)).toBe(1);
    expect(store.get('pd1.old')?.status).toBe('expired');
    store.expire(new Date(Date.now() + 2500));
    expect(store.get('pd1.old')).toBeNull();
    expect(store.get('pd1.new')?.status).toBe('pending');
  });
});

describe('approval tenancy', () => {
  it('refuses a human approval from another tenant', async () => {
    const store = memoryApprovalStore();
    store.create(pending('pd1.t', 'o_1'));
    await expect(
      resolveApproval(store, 'pd1.t', {
        status: 'approved',
        by: approver('u_9', ['o_2']),
      }),
    ).rejects.toThrow(/tenant/u);
    expect(() =>
      store.resolve('pd1.t', {
        status: 'approved',
        by: approver('u_9', ['o_2']),
      }),
    ).toThrow(/tenant/u);
  });

  it('scopes the inbox to the approver membership tenants', async () => {
    const store = memoryApprovalStore();
    store.create(pending('pd1.o1', 'o_1'));
    store.create(pending('pd1.o2', 'o_2'));
    store.create(pending('pd1.none', undefined));
    const inbox = async (subject: Subject) => {
      const fetch = approvalsHandler(store, { subject: () => subject });
      const response = await fetch(
        new Request('https://api.example.com/permdock/approvals/pending'),
      );
      const body = (await response.json()) as ApprovalRequest[];
      return body.map((request) => request.token).toSorted();
    };
    expect(await inbox(approver('u_9', ['o_1']))).toEqual([
      'pd1.none',
      'pd1.o1',
    ]);
    expect(await inbox(approver('u_9', []))).toEqual(['pd1.none']);
  });

  it('lists only the requests the caller may resolve', async () => {
    const store = memoryApprovalStore();
    store.create(pending('pd1.own', 'o_1'));
    store.create(
      pending('pd1.owner', 'o_1', {
        subject: { principal: { id: 'u_2', roles: ['member'], tenant: 'o_1' } },
        approvers: { by: ['owner'] },
      }),
    );
    store.create(
      pending('pd1.agent', 'o_1', {
        subject: {
          principal: { id: 'u_3', roles: ['member'], tenant: 'o_1' },
          actor: { id: 'u_1', kind: 'mcp-client' },
        },
      }),
    );
    const inbox = async (distinct: boolean) => {
      const fetch = approvalsHandler(store, {
        subject: () => approver('u_1', ['o_1']),
        requireDistinctApprover: distinct,
      });
      const response = await fetch(
        new Request('https://api.example.com/permdock/approvals/pending'),
      );
      const body = (await response.json()) as ApprovalRequest[];
      return body.map((request) => request.token).toSorted();
    };
    expect(await inbox(true)).toEqual([]);
    expect(await inbox(false)).toEqual(['pd1.own']);
  });
});

describe('approval token inputs', () => {
  const base = {
    key: 'post.delete',
    resourceId: '42',
    actor: { id: 'agent', kind: 'mcp-client' },
    fingerprint: 'f',
  };

  it('survives a session refresh that changes roles or assurance', () => {
    const before = decisionToken({
      ...base,
      principal: { id: 'u_1', roles: ['member'], tenant: 'o_1', issuer: 'i' },
    });
    const after = decisionToken({
      ...base,
      principal: {
        id: 'u_1',
        roles: ['member', 'editor'],
        tenant: 'o_1',
        issuer: 'i',
        assurance: { authTime: 1_900_000_000 },
      },
    });
    expect(after).toBe(before);
  });

  it('changes with the principal id, tenant, issuer or actor', () => {
    const token = (
      principal: Record<string, unknown>,
      actor = base.actor,
    ): string =>
      decisionToken({ ...base, actor, principal: principal as never });
    const reference = token({ id: 'u_1', tenant: 'o_1', issuer: 'i' });
    expect(token({ id: 'u_2', tenant: 'o_1', issuer: 'i' })).not.toBe(
      reference,
    );
    expect(token({ id: 'u_1', tenant: 'o_2', issuer: 'i' })).not.toBe(
      reference,
    );
    expect(token({ id: 'u_1', tenant: 'o_1', issuer: 'j' })).not.toBe(
      reference,
    );
    expect(
      token(
        { id: 'u_1', tenant: 'o_1', issuer: 'i' },
        { id: 'other', kind: 'mcp-client' },
      ),
    ).not.toBe(reference);
  });
});
