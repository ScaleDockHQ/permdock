import { describe, expect, it } from 'vitest';

import type {
  ApprovalRequest,
  ApprovalStore,
} from '../../src/approvals/index.ts';
import type { Subject } from '../../src/core/subject.ts';

import {
  ApprovalError,
  approvalsHandler,
  memoryApprovalStore,
} from '../../src/approvals/index.ts';

const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const BASE = 'https://api.example.com/permdock/approvals';

function pending(
  token: string,
  principal: ApprovalRequest['subject']['principal'],
): ApprovalRequest {
  return {
    v: 1,
    token,
    permission: 'post.delete',
    scope: 'post:delete',
    resource: { type: 'post', id: '42' },
    subject: { principal },
    detail: 'post.delete requires human approval.',
    createdAt: new Date().toISOString(),
    expiresAt: future,
    status: 'pending',
  };
}

function seeded(): ApprovalStore {
  const store = memoryApprovalStore();
  store.create(pending('own', { id: 'u_1', roles: ['member'], tenant: 'o_1' }));
  store.create(
    pending('acme', { id: 'u_2', roles: ['member'], tenant: 'o_acme' }),
  );
  store.create(pending('loose', { id: 'u_3', roles: ['member'] }));
  store.create(pending('anon', null));
  return store;
}

const viewer: Subject = {
  principal: {
    id: 'u_1',
    roles: [],
    memberships: [{ tenant: 'o_1', roles: ['admin'] }],
  },
  context: {},
};

describe('approvalsHandler GET by token', () => {
  it.each<[string, number]>([
    ['own', 200],
    ['acme', 404],
    ['loose', 200],
    ['anon', 200],
    ['missing', 404],
  ])('shows %s with %d', async (token, status) => {
    const handler = approvalsHandler(seeded(), { subject: () => viewer });
    expect((await handler(new Request(`${BASE}/${token}`))).status).toBe(
      status,
    );
  });

  it('refuses an undefined subject and an unknown route', async () => {
    const handler = approvalsHandler(seeded(), { subject: () => undefined });
    expect((await handler(new Request(`${BASE}/own`))).status).toBe(401);
    expect(
      (await handler(new Request(`${BASE}/own`, { method: 'DELETE' }))).status,
    ).toBe(405);
    expect(
      (await handler(new Request('https://api.example.com/'))).status,
    ).toBe(405);
  });
});

describe('approvalsHandler error mapping', () => {
  it.each<[ApprovalError['code'], number]>([
    ['approval-not-found', 404],
    ['approval-not-pending', 409],
    ['approval-expired', 409],
    ['approver-unauthenticated', 401],
    ['approver-not-eligible', 403],
  ])('maps %s to %d', async (code, status) => {
    const store: ApprovalStore = {
      ...seeded(),
      resolve: () => {
        throw new ApprovalError(code, code);
      },
    };
    const handler = approvalsHandler(store, { subject: () => viewer });
    const response = await handler(
      new Request(`${BASE}/loose/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note: 7 }),
      }),
    );
    expect(response.status).toBe(status);
  });

  it('ignores an unreadable note', async () => {
    const handler = approvalsHandler(seeded(), { subject: () => viewer });
    const response = await handler(
      new Request(`${BASE}/loose/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{nope',
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe('approvalsHandler inbox', () => {
  it('lists across membership tenants for a principal without an active tenant and pages', async () => {
    const store = seeded();
    const handler = approvalsHandler(store, {
      subject: () => ({
        principal: {
          id: 'u_9',
          roles: [],
          memberships: [{ tenant: 'o_acme', roles: ['admin'] }],
        },
        context: {},
      }),
    });
    const response = await handler(new Request(`${BASE}/pending?limit=1`));
    // SAFETY: response JSON produced by approvalsHandler's pending route under test.
    const body = (await response.json()) as {
      readonly items: readonly ApprovalRequest[];
      readonly next?: string;
    };
    expect({
      status: response.status,
      paged: body.items.length <= 1,
      next: typeof body.next,
    }).toEqual({
      status: 200,
      paged: true,
      next: 'string',
    });
  });
});
