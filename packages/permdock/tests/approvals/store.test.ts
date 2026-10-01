import { describe, expect, it } from 'vitest';

import type {
  ApprovalRequest,
  ApprovalStore,
} from '../../src/approvals/index.ts';
import type { TokenSigner } from '../../src/core/interfaces.ts';
import type { Subject } from '../../src/core/subject.ts';

import {
  APPROVAL_HEADER,
  approvalsHandler,
  inspectApproval,
  memoryApprovalStore,
  readApprovalHeader,
  requestApproval,
  resolveApproval,
  resumeFromHeader,
} from '../../src/approvals/index.ts';

const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const created = new Date().toISOString();

function subject(id: string, tenant?: string): Subject {
  return {
    principal: {
      id,
      roles: ['admin'],
      tenant,
      memberships:
        tenant === undefined ? undefined : [{ tenant, roles: ['admin'] }],
    },
    context: {},
  };
}

function pending(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    v: 1,
    token: 'pd1.token-1',
    permission: 'post.delete',
    scope: 'post:delete',
    resource: { type: 'post', id: '42' },
    subject: {
      principal: { id: 'u_1', roles: ['member'], tenant: 'o_1' },
      actor: { id: 'eve:app', kind: 'eve' },
    },
    detail: 'post.delete requires human approval.',
    adapter: 'eve',
    createdAt: created,
    expiresAt: future,
    status: 'pending',
    ...overrides,
  };
}

describe('memoryApprovalStore', () => {
  it('creates, lists, resolves and expires requests', () => {
    const store = memoryApprovalStore();
    store.create(pending());
    expect(store.get('pd1.token-1')?.status).toBe('pending');
    expect(store.list({ status: 'pending' }).items).toHaveLength(1);
    expect(store.list({ tenant: 'o_1' }).items).toHaveLength(1);
    expect(store.list({ tenant: 'o_other' }).items).toHaveLength(0);
    expect(store.list({ principalId: 'u_1' }).items).toHaveLength(1);
    expect(store.list({ actorId: 'missing' }).items).toHaveLength(0);
    expect(store.list({ principalId: 'missing' }).items).toHaveLength(0);

    const resolved = store.resolve('pd1.token-1', {
      status: 'approved',
      by: subject('u_9', 'o_1'),
      note: 'ok',
    });
    expect(resolved.status).toBe('approved');
    expect(resolved.resolvedBy).toBe('u_9');
    expect(resolved.note).toBe('ok');
    expect(() =>
      store.resolve('pd1.token-1', {
        status: 'rejected',
        by: subject('u_8', 'o_1'),
      }),
    ).toThrow('approval is not pending');
  });

  it('keeps a resolved request when the same call asks again', () => {
    const store = memoryApprovalStore();
    store.create(pending());
    store.resolve('pd1.token-1', {
      status: 'approved',
      by: subject('u_9', 'o_1'),
    });
    store.create(pending({ detail: 'asked again' }));
    expect(store.get('pd1.token-1')?.status).toBe('approved');
    expect(store.list({ status: 'pending' }).items).toHaveLength(0);
  });

  it('replaces an expired request on a new ask', () => {
    const store = memoryApprovalStore();
    store.create(pending({ expiresAt: past }));
    store.create(pending());
    expect(store.get('pd1.token-1')?.status).toBe('pending');
    expect(store.get('pd1.token-1')?.expiresAt).toBe(future);
  });

  it('treats unknown tokens as missing and refuses the actor', () => {
    const store = memoryApprovalStore({ ttl: 1_000 });
    expect(store.ttl).toBe(1_000);
    expect(store.get('missing')).toBeNull();
    expect(() =>
      store.resolve('missing', { status: 'approved', by: subject('u_9') }),
    ).toThrow('approval was not found');
    store.create(pending());
    expect(() =>
      store.resolve('pd1.token-1', {
        status: 'approved',
        by: subject('eve:app', 'o_1'),
      }),
    ).toThrow('approver is the actor of this request');
  });

  it('marks stale pending requests expired', () => {
    const store = memoryApprovalStore();
    store.create(pending({ expiresAt: past }));
    expect(store.expire(new Date())).toBe(1);
    expect(store.get('pd1.token-1')?.status).toBe('expired');
    expect(store.expire(new Date())).toBe(0);
  });

  it('refuses resolve on an expired pending request', () => {
    const store = memoryApprovalStore();
    store.create(pending({ expiresAt: past }));
    expect(() =>
      store.resolve('pd1.token-1', {
        status: 'approved',
        by: subject('u_9', 'o_1'),
      }),
    ).toThrow('approval has expired');
  });
});

describe('request and resume helpers', () => {
  it('records an approval-required decision and inspects resume tokens', async () => {
    const store = memoryApprovalStore();
    const recorded = await requestApproval(
      store,
      {
        outcome: 'approval-required',
        grant: { role: 'member', permission: 'post.delete' },
        reason: 'human',
        token: 'pd1.abc',
      },
      {
        permission: {
          key: 'post.delete',
          scope: 'post:delete',
          resource: 'post',
        },
        resource: { type: 'post', id: '42' },
        subject: {
          principal: { id: 'u_1', roles: ['member'], tenant: 'o_1' },
          actor: { id: 'eve:app', kind: 'eve' },
          context: {},
        },
        adapter: 'eve',
        ttl: 3_600_000,
      },
    );
    expect(recorded.status).toBe('pending');
    expect(recorded.token).toBe('pd1.abc');
    expect(recorded.v).toBe(1);

    const pendingInspect = await inspectApproval(store, 'pd1.abc');
    expect(pendingInspect.ok).toBe(false);
    if (!pendingInspect.ok) {
      expect(pendingInspect.detail).toBe('approval-pending');
    }

    const approved = await resolveApproval(store, 'pd1.abc', {
      status: 'approved',
      by: subject('u_9', 'o_1'),
    });
    expect(approved.status).toBe('approved');

    const headers = new Headers({ [APPROVAL_HEADER]: 'pd1.abc' });
    expect(readApprovalHeader(headers)).toBe('pd1.abc');
    const resumed = await resumeFromHeader(store, headers);
    expect(resumed.ok).toBe(true);

    expect(readApprovalHeader(new Headers())).toBeUndefined();
    expect((await resumeFromHeader(store, new Headers())).ok).toBe(false);
    expect((await inspectApproval(store, 'missing')).ok).toBe(false);
  });

  it('summarises delegation and refuses an anonymous approver', async () => {
    const store = memoryApprovalStore();
    const recorded = await requestApproval(
      store,
      {
        outcome: 'approval-required',
        grant: { role: 'member', permission: 'post.delete' },
        reason: 'human',
        token: 'pd1.del',
      },
      {
        permission: {
          key: 'post.delete',
          scope: 'post:delete',
          resource: 'post',
        },
        subject: {
          principal: { id: 'u_1', roles: ['member'] },
          actor: { id: 'eve:app', kind: 'eve' },
          delegation: { scopes: ['post:delete'] },
          context: {},
        },
      },
    );
    expect(recorded.subject.delegation?.scopes).toEqual(['post:delete']);
    expect(recorded.detail).toBe('post.delete requires human approval.');
    expect(() =>
      store.resolve('pd1.del', {
        status: 'approved',
        by: { principal: null, context: {} },
      }),
    ).toThrow('approver must be authenticated');
    expect(store.list({ status: 'approved' }).items).toHaveLength(0);

    store.create(pending({ token: 'pd1.gone', status: 'expired' }));
    expect(await inspectApproval(store, 'pd1.gone')).toEqual({
      ok: false,
      detail: 'approval-expired',
    });
    await expect(
      resolveApproval(store, 'missing', {
        status: 'approved',
        by: subject('u_9'),
      }),
    ).rejects.toThrow('approval was not found');
    await expect(
      resolveApproval(store, 'pd1.del', {
        status: 'approved',
        by: { principal: null, context: {} },
      }),
    ).rejects.toThrow('approver must be authenticated');
    store.create(
      pending({
        token: 'pd1.old-ok',
        status: 'approved',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        resolvedBy: 'u_9',
        resolvedAt: created,
      }),
    );
    expect(await inspectApproval(store, 'pd1.old-ok')).toEqual({
      ok: false,
      detail: 'approval-expired',
    });
  });

  it('classifies rejected and expired resumes', async () => {
    const store = memoryApprovalStore();
    store.create(pending({ token: 'pd1.rej' }));
    await resolveApproval(
      store,
      'pd1.rej',
      { status: 'rejected', by: subject('u_9', 'o_1') },
      { requireDistinctApprover: true },
    );
    const rejected = await inspectApproval(store, 'pd1.rej');
    expect(rejected).toEqual({ ok: false, detail: 'approval-rejected' });

    store.create(pending({ token: 'pd1.old', expiresAt: past }));
    const expired = await inspectApproval(store, 'pd1.old');
    expect(expired).toEqual({ ok: false, detail: 'approval-expired' });
  });

  it('records grant approvers and the subject session on requests', async () => {
    const store = memoryApprovalStore();
    const recorded = await requestApproval(
      store,
      {
        outcome: 'approval-required',
        grant: {
          role: 'member',
          permission: 'filing.pay',
          approval: {
            by: { kind: 'role', role: 'admin', scope: 'tenant' },
            distinct: true,
          },
        },
        reason: 'human',
        token: 'pd1.pay',
      },
      {
        permission: {
          key: 'filing.pay',
          scope: 'filing:pay',
          resource: 'filing',
        },
        subject: {
          principal: { id: 'u_1', roles: ['member'], tenant: 'o_1' },
          session: 'sid-1',
          context: {},
        },
      },
    );
    expect(recorded.v).toBe(1);
    expect(recorded.approvers).toEqual({
      by: { kind: 'role', role: 'admin', scope: 'tenant' },
      distinct: true,
    });
    expect(recorded.subject.session).toBe('sid-1');
    expect(recorded.detail).toBe('filing.pay requires approval from admin.');
  });

  it('refuses a principal-as-approver when four-eyes is required', async () => {
    const store = memoryApprovalStore();
    store.create(pending());
    await expect(
      resolveApproval(
        store,
        'pd1.token-1',
        { status: 'approved', by: subject('u_1', 'o_1') },
        { requireDistinctApprover: true },
      ),
    ).rejects.toThrow('approver is the principal of this request');
  });

  it('refuses an approver who does not match approval.by', async () => {
    const store = memoryApprovalStore();
    store.create(
      pending({
        approvers: {
          by: { kind: 'role', role: 'admin', scope: 'tenant' },
          distinct: true,
        },
      }),
    );
    await expect(
      resolveApproval(store, 'pd1.token-1', {
        status: 'approved',
        by: {
          principal: {
            id: 'u_2',
            roles: ['member'],
            tenant: 'o_1',
            memberships: [{ tenant: 'o_1', roles: ['member'] }],
          },
          context: {},
        },
      }),
    ).rejects.toThrow('approver does not hold an eligible role');
    const approved = await resolveApproval(store, 'pd1.token-1', {
      status: 'approved',
      by: subject('u_9', 'o_1'),
    });
    expect(approved.status).toBe('approved');
  });

  it('refuses every approver for a relation approver it cannot check', async () => {
    const store = memoryApprovalStore();
    store.create(
      pending({
        approvers: {
          by: { kind: 'relation', resource: 'post', relation: 'owner' },
          distinct: true,
        },
      }),
    );
    await expect(
      resolveApproval(store, 'pd1.token-1', {
        status: 'approved',
        by: subject('u_9', 'o_1'),
      }),
    ).rejects.toThrow('approver does not hold an eligible role');
  });

  it('cancels pending requests for a session without checking eligibility', () => {
    const store = memoryApprovalStore();
    store.create(
      pending({ subject: { ...pending().subject, session: 'sid-1' } }),
    );
    store.create(
      pending({
        token: 'pd1.other',
        subject: { ...pending().subject, session: 'sid-2' },
      }),
    );
    expect(
      store.cancel?.({ session: 'sid-1' }, { by: 'ssf', note: 'jti-1' }),
    ).toBe(1);
    expect(store.get('pd1.token-1')?.status).toBe('rejected');
    expect(store.get('pd1.token-1')?.resolvedBy).toBe('system:ssf');
    expect(store.get('pd1.other')?.status).toBe('pending');
  });
});

describe('approvalsHandler', () => {
  function handler(
    store = memoryApprovalStore(),
    options?: {
      readonly requireDistinctApprover?: boolean;
      readonly signer?: TokenSigner;
      readonly subjectId?: string;
      readonly tenant?: string;
      readonly anonymous?: boolean;
      readonly throwSubject?: boolean;
    },
  ): {
    readonly store: ReturnType<typeof memoryApprovalStore>;
    readonly fetch: (request: Request) => Promise<Response>;
  } {
    store.create(pending());
    const fetch = approvalsHandler(store, {
      requireDistinctApprover: options?.requireDistinctApprover,
      signer: options?.signer,
      subject: () => {
        if (options?.throwSubject === true) {
          throw new Error('boom');
        }
        if (options?.anonymous === true) {
          return { principal: null, context: {} };
        }
        return subject(options?.subjectId ?? 'u_9', options?.tenant ?? 'o_1');
      },
    });
    return { store, fetch };
  }

  it('lists pending and own requests for an authenticated approver', async () => {
    const { fetch } = handler();
    const pendingRes = await fetch(
      new Request('https://api.example.com/permdock/approvals/pending'),
    );
    expect(pendingRes.status).toBe(200);
    expect(await pendingRes.json()).toEqual({
      items: [
        expect.objectContaining({ token: 'pd1.token-1', status: 'pending' }),
      ],
    });

    const mine = await fetch(
      new Request('https://api.example.com/permdock/approvals/mine'),
    );
    expect(mine.status).toBe(200);
    expect(await mine.json()).toEqual({ items: [] });

    const one = await fetch(
      new Request('https://api.example.com/permdock/approvals/pd1.token-1'),
    );
    expect(one.status).toBe(200);
  });

  it('approves, rejects, and signs the approved token', async () => {
    const signer: TokenSigner = {
      async sign(payload, options) {
        expect(options.typ).toBe('permdock-approval+jwt');
        expect(payload['approval']).toEqual(
          expect.objectContaining({ token: 'pd1.token-1', status: 'approved' }),
        );
        return 'a.b.c';
      },
    };
    const { fetch } = handler(memoryApprovalStore(), { signer });
    const approved = await fetch(
      new Request(
        'https://api.example.com/permdock/approvals/pd1.token-1/approve',
        { method: 'POST' },
      ),
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual(
      expect.objectContaining({ status: 'approved', signed: 'a.b.c' }),
    );

    const { fetch: rejectFetch } = handler();
    const rejected = await rejectFetch(
      new Request(
        'https://api.example.com/permdock/approvals/pd1.token-1/reject',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note: 'no' }),
        },
      ),
    );
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toEqual(
      expect.objectContaining({ status: 'rejected', note: 'no' }),
    );
  });

  it('maps auth, tenancy and conflict failures to Problem Details', async () => {
    const anonymous = handler(memoryApprovalStore(), { anonymous: true });
    expect(
      (
        await anonymous.fetch(
          new Request('https://api.example.com/permdock/approvals/pending'),
        )
      ).status,
    ).toBe(401);

    const thrown = handler(memoryApprovalStore(), { throwSubject: true });
    expect(
      (
        await thrown.fetch(
          new Request('https://api.example.com/permdock/approvals/pending'),
        )
      ).status,
    ).toBe(401);

    const foreign = handler(memoryApprovalStore(), { tenant: 'o_other' });
    expect(
      (
        await foreign.fetch(
          new Request(
            'https://api.example.com/permdock/approvals/pending?tenant=o_1',
          ),
        )
      ).status,
    ).toBe(403);

    const actor = handler(memoryApprovalStore(), { subjectId: 'eve:app' });
    expect(
      (
        await actor.fetch(
          new Request(
            'https://api.example.com/permdock/approvals/pd1.token-1/approve',
            { method: 'POST' },
          ),
        )
      ).status,
    ).toBe(403);

    const fourEyes = handler(memoryApprovalStore(), {
      subjectId: 'u_1',
      requireDistinctApprover: true,
    });
    expect(
      (
        await fourEyes.fetch(
          new Request(
            'https://api.example.com/permdock/approvals/pd1.token-1/approve',
            { method: 'POST' },
          ),
        )
      ).status,
    ).toBe(403);

    const missing = handler();
    expect(
      (
        await missing.fetch(
          new Request('https://api.example.com/permdock/approvals/nope'),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await missing.fetch(
          new Request(
            'https://api.example.com/permdock/approvals/nope/approve',
            { method: 'POST' },
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await missing.fetch(
          new Request('https://api.example.com/permdock/approvals/pending', {
            method: 'DELETE',
          }),
        )
      ).status,
    ).toBe(405);

    const twice = handler();
    await twice.fetch(
      new Request(
        'https://api.example.com/permdock/approvals/pd1.token-1/approve',
        { method: 'POST' },
      ),
    );
    expect(
      (
        await twice.fetch(
          new Request(
            'https://api.example.com/permdock/approvals/pd1.token-1/approve',
            { method: 'POST' },
          ),
        )
      ).status,
    ).toBe(409);

    const scoped = handler();
    expect(
      (
        await scoped.fetch(
          new Request(
            'https://api.example.com/permdock/approvals/pending?tenant=o_1',
          ),
        )
      ).status,
    ).toBe(200);

    const owner = handler(memoryApprovalStore(), { subjectId: 'u_1' });
    const mine = await owner.fetch(
      new Request('https://api.example.com/permdock/approvals/mine'),
    );
    expect(await mine.json()).toEqual({
      items: [expect.objectContaining({ token: 'pd1.token-1' })],
    });

    const outsider = handler(memoryApprovalStore(), { tenant: 'o_other' });
    expect(
      (
        await outsider.fetch(
          new Request('https://api.example.com/permdock/approvals/pd1.token-1'),
        )
      ).status,
    ).toBe(404);

    const bareStore = memoryApprovalStore();
    bareStore.create(
      pending({
        subject: { principal: { id: 'u_1', roles: ['member'] } },
      }),
    );
    const bareHandler = approvalsHandler(bareStore, {
      subject: () => ({
        principal: { id: 'u_9', roles: ['admin'] },
        context: {},
      }),
    });
    expect(
      (
        await bareHandler(
          new Request('https://api.example.com/permdock/approvals/pending'),
        )
      ).status,
    ).toBe(200);

    const invalidJson = handler();
    expect(
      (
        await invalidJson.fetch(
          new Request(
            'https://api.example.com/permdock/approvals/pd1.token-1/reject',
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{',
            },
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (await invalidJson.fetch(new Request('https://api.example.com/'))).status,
    ).toBe(405);

    const plain = handler();
    expect(
      (
        await plain.fetch(
          new Request(
            'https://api.example.com/permdock/approvals/pd1.token-1/reject',
            {
              method: 'POST',
              headers: { 'content-type': 'text/plain' },
              body: 'nope',
            },
          ),
        )
      ).status,
    ).toBe(200);

    const broken: ApprovalStore = {
      create: () => undefined,
      get: () => null,
      resolve: () => {
        throw new Error('db');
      },
      list: () => {
        throw new Error('db');
      },
      expire: () => 0,
    };
    const failing = approvalsHandler(broken, {
      subject: () => subject('u_9', 'o_1'),
    });
    expect(
      (
        await failing(
          new Request('https://api.example.com/permdock/approvals/pending'),
        )
      ).status,
    ).toBe(500);
  });
});
