import { describe, expect, it } from 'vitest';

import type { EveApprovalContext, EveResponseContext } from './index.ts';

import { memoryApprovalStore } from '../approvals/index.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { createPermDock } from './index.ts';

type Person = { readonly id: string; readonly roles: readonly string[] };

function principal(user: Person) {
  return {
    principalId: user.id,
    principalType: 'user',
    authenticator: 'test',
    attributes: { roles: user.roles },
  };
}

function sessionFor(user: Person, current: Person = user) {
  return {
    id: 's1',
    auth: { initiator: principal(user), current: principal(current) },
  };
}

function call(
  toolName: string,
  toolInput: unknown,
  callId = 'c1',
  user: Person = memberUser,
): EveApprovalContext {
  return { session: sessionFor(user), callId, toolName, toolInput };
}

function respond(
  responder: { readonly principalId: string; readonly roles?: unknown },
  request: { readonly toolName: string; readonly toolInput?: unknown },
  callId = 'c1',
  initiator: Person = memberUser,
): EveResponseContext {
  return {
    request: { callId, requestId: `r-${callId}`, ...request },
    responder: {
      principalId: responder.principalId,
      attributes:
        responder.roles === undefined
          ? {}
          : { roles: responder.roles as string | readonly string[] },
    },
    session: { id: 's1', initiator: principal(initiator) },
  };
}

function tools() {
  return {
    delete_post: {
      permission: permissions.post.delete,
      data: (input: unknown) => {
        const id = (input as { readonly id?: string } | undefined)?.id;
        return id === 'p1' ? ownPost : otherPost;
      },
    },
    list_posts: { permission: permissions.post.list },
    publish_post: {
      permission: permissions.post.publish,
      data: () => ownPost,
    },
  };
}

const deleteOwn = { toolName: 'delete_post', toolInput: { id: 'p1' } };

describe('permdock/eve', () => {
  it('maps granted to not-applicable and denied to a typed denial', async () => {
    const { approval, permdock } = createPermDock(policy, { tools: tools() });

    expect(await approval.request(call('list_posts', {}))).toBe(
      'not-applicable',
    );
    expect((await permdock(call('list_posts', {}))).subject.principal?.id).toBe(
      'u1',
    );
    expect(
      await approval.request(call('publish_post', { id: 'p1' })),
    ).toMatchObject({ type: 'denied' });
    expect(await approval.request(call('explode', {}))).toEqual({
      type: 'denied',
      reason: 'Denied: unmapped tool explode.',
    });
  });

  it('parks a call, checks the responder, and runs the re-check once', async () => {
    const store = memoryApprovalStore();
    const { approval } = createPermDock(policy, {
      tools: tools(),
      store,
      approvers: { roles: ['admin'] },
    });

    expect(await approval.request(call('delete_post', { id: 'p1' }))).toBe(
      'user-approval',
    );
    expect(
      await approval.response(
        respond({ principalId: 'eve:app', roles: ['admin'] }, deleteOwn),
      ),
    ).toEqual({
      status: 'rejected',
      reason: 'approver is the actor of this request',
    });
    expect(
      await approval.response(
        respond({ principalId: 'u9', roles: ['member'] }, deleteOwn),
      ),
    ).toEqual({ status: 'rejected', reason: 'approver is not eligible' });
    expect(
      await approval.response(
        respond({ principalId: 'u2', roles: 'admin' }, deleteOwn),
      ),
    ).toEqual({ status: 'allowed' });

    expect(await approval.request(call('delete_post', { id: 'p1' }))).toBe(
      'not-applicable',
    );
    expect(
      await approval.request(call('delete_post', { id: 'p1' })),
    ).toMatchObject({ type: 'denied' });
  });

  it('denies the re-check of a call nobody approved', async () => {
    const { approval } = createPermDock(policy, { tools: tools() });
    expect(await approval.request(call('delete_post', { id: 'p1' }))).toBe(
      'user-approval',
    );
    const recheck = await approval.request(call('delete_post', { id: 'p1' }));
    expect(recheck).toMatchObject({ type: 'denied' });
  });

  it('resolves a response in another process from the shared store', async () => {
    const store = memoryApprovalStore();
    const first = createPermDock(policy, { tools: tools(), store });
    expect(
      await first.approval.request(call('delete_post', { id: 'p1' })),
    ).toBe('user-approval');

    const second = createPermDock(policy, { tools: tools(), store });
    expect(
      await second.approval.response(
        respond({ principalId: 'u2', roles: ['admin'] }, deleteOwn),
      ),
    ).toEqual({ status: 'allowed' });

    const third = createPermDock(policy, { tools: tools(), store });
    expect(
      await third.approval.request(call('delete_post', { id: 'p1' })),
    ).toBe('not-applicable');
  });

  it('rejects a response for a call that never asked', async () => {
    const { approval } = createPermDock(policy, { tools: tools() });
    expect(
      await approval.response(
        respond({ principalId: 'u2', roles: ['admin'] }, deleteOwn, 'c9'),
      ),
    ).toEqual({ status: 'rejected', reason: 'approval-not-found' });
  });

  it('builds a single-tool pair with approvalFor and ignores tool-input subjects', async () => {
    const { approvalFor } = createPermDock(policy, { tools: tools() });
    const pair = approvalFor(permissions.post.publish, () => ownPost);
    const denied = await pair.request(
      call('publish', { subject: { id: 'u2', roles: ['admin'] } }),
    );
    expect(denied).toMatchObject({ type: 'denied' });
  });

  it('treats missing session auth as anonymous', async () => {
    const { approval } = createPermDock(policy, { tools: tools() });
    const denied = await approval.request({
      toolName: 'list_posts',
      toolInput: {},
    });
    expect(denied).toMatchObject({ type: 'denied' });
    const noInitiator = await approval.request({
      session: { id: 's1', auth: { initiator: null, current: null } },
      toolName: 'list_posts',
      toolInput: {},
    });
    expect(noInitiator).toMatchObject({ type: 'denied' });
  });
});
