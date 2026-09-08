import { describe, expect, it } from 'vitest';

import { memoryApprovalStore } from '../approvals/index.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { createPermDock } from './index.ts';

function sessionFor(
  user: { readonly id: string; readonly roles: readonly string[] },
  currentId = user.id,
) {
  return {
    auth: {
      initiator: {
        principalId: user.id,
        attributes: { roles: user.roles },
      },
      current: { principalId: currentId },
    },
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

describe('permdock/eve', () => {
  it('maps granted to not-applicable and denied to a typed denial', async () => {
    const { approval, permdock } = createPermDock(policy, { tools: tools() });
    const ctx = { session: sessionFor(memberUser) };

    expect(
      await approval.request(ctx, { toolName: 'list_posts', toolInput: {} }),
    ).toBe('not-applicable');
    expect((await permdock(ctx)).subject.principal?.id).toBe('u1');

    const denied = await approval.request(ctx, {
      toolName: 'publish_post',
      toolInput: { id: 'p1' },
    });
    expect(denied).toMatchObject({ type: 'denied' });

    const unmapped = await approval.request(ctx, {
      toolName: 'explode',
      toolInput: {},
    });
    expect(unmapped).toEqual({
      type: 'denied',
      reason: 'Denied: unmapped tool explode.',
    });
  });

  it('parks approval-required calls and refuses the actor as approver', async () => {
    const store = memoryApprovalStore();
    const { approval } = createPermDock(policy, {
      tools: tools(),
      store,
      approvers: { roles: ['admin'] },
    });
    const ctx = { session: sessionFor(memberUser) };

    expect(
      await approval.request(ctx, {
        toolName: 'delete_post',
        toolInput: { id: 'p1' },
        callId: 'c1',
      }),
    ).toBe('user-approval');

    expect(
      await approval.response(
        { principalId: 'eve:app', roles: ['admin'] },
        { callId: 'c1' },
      ),
    ).toEqual({
      status: 'rejected',
      reason: 'approver is the actor of this request',
    });

    expect(
      await approval.response(
        { principalId: 'u9', roles: ['member'] },
        {
          callId: 'c1',
        },
      ),
    ).toEqual({ status: 'rejected', reason: 'approver is not eligible' });

    expect(
      await approval.response(
        { principalId: 'u2', roles: ['admin'] },
        {
          callId: 'c1',
        },
      ),
    ).toEqual({ status: 'allowed' });

    expect(
      await approval.request(ctx, {
        toolName: 'delete_post',
        toolInput: { id: 'p1' },
        callId: 'c1',
      }),
    ).toBe('not-applicable');
  });

  it('builds a single-tool pair with approvalFor and ignores tool-input subjects', async () => {
    const { approvalFor } = createPermDock(policy, { tools: tools() });
    const pair = approvalFor(permissions.post.publish, () => ownPost);
    const denied = await pair.request(
      { session: sessionFor(memberUser) },
      {
        toolName: 'publish',
        toolInput: { subject: { id: 'u2', roles: ['admin'] } },
      },
    );
    expect(denied).toMatchObject({ type: 'denied' });
  });

  it('treats missing session auth as anonymous', async () => {
    const { approval } = createPermDock(policy, { tools: tools() });
    const denied = await approval.request(
      {},
      { toolName: 'list_posts', toolInput: {} },
    );
    expect(denied).toMatchObject({ type: 'denied' });
  });
});
