import { describe, expect, it, vi } from 'vitest';

import { memoryApprovalStore } from '../approvals/index.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { createPermDock } from './index.ts';

function tools() {
  return {
    delete_post: {
      permission: permissions.post.delete,
      data: (args: unknown) => {
        const id = (args as { readonly id?: string }).id;
        return id === 'p1' ? ownPost : otherPost;
      },
    },
    list_posts: { permission: permissions.post.list },
    publish_post: {
      permission: permissions.post.publish,
      data: (args: unknown) => {
        const id = (args as { readonly id?: string }).id;
        return id === 'p1' ? ownPost : otherPost;
      },
    },
  };
}

describe('permdock/ai-sdk', () => {
  it('maps granted, denied and unmapped tools without not-applicable', async () => {
    const { toolApproval } = createPermDock(policy, {
      subject: ({ runtimeContext }) =>
        (runtimeContext as { readonly user: unknown }).user,
      actor: () => ({ id: 'agent-1', kind: 'ai-sdk' }),
      tools: tools(),
    });

    const granted = await toolApproval({
      toolCall: { toolName: 'list_posts', input: {} },
      runtimeContext: { user: memberUser },
    });
    expect(granted).toBe('approved');

    const denied = await toolApproval({
      toolCall: { toolName: 'publish_post', input: { id: 'p1' } },
      runtimeContext: { user: memberUser },
    });
    expect(denied).toMatchObject({ type: 'denied' });
    if (typeof denied !== 'string') {
      expect(denied.type).toBe('denied');
      expect(denied.reason).toContain('post.publish');
      expect(denied.reason).toContain('Alternatives');
    }

    const unmapped = await toolApproval({
      toolCall: { toolName: 'explode', input: {} },
      runtimeContext: { user: memberUser },
    });
    expect(unmapped).toEqual({
      type: 'denied',
      reason: 'Denied: unmapped tool explode.',
    });
  });

  it('asks for approval and refuses a tampered resume token', async () => {
    const store = memoryApprovalStore();
    const { toolApproval } = createPermDock(policy, {
      subject: () => memberUser,
      actor: () => ({ id: 'agent-1', kind: 'ai-sdk' }),
      tools: tools(),
      store,
    });

    const asked = await toolApproval({
      toolCall: { toolName: 'delete_post', input: { id: 'p1' } },
    });
    expect(asked).toMatchObject({ type: 'user-approval' });
    if (typeof asked === 'string' || asked.type !== 'user-approval') {
      throw new Error('expected user-approval');
    }
    expect(await store.get(asked.token)).not.toBeNull();

    await store.resolve(asked.token, {
      status: 'approved',
      by: { principal: { id: 'u2', roles: ['admin'] }, context: {} },
    });

    const resumed = await toolApproval({
      toolCall: { toolName: 'delete_post', input: { id: 'p1' } },
      runtimeContext: { token: asked.token },
    });
    expect(resumed).toBe('approved');

    const tampered = await toolApproval({
      toolCall: { toolName: 'delete_post', input: { id: 'p2' } },
      runtimeContext: { token: asked.token },
    });
    expect(tampered).toMatchObject({ type: 'denied' });
  });

  it('never trusts a subject or actor from tool arguments', async () => {
    const { toolApproval } = createPermDock(policy, {
      subject: () => memberUser,
      actor: () => ({ id: 'agent-1', kind: 'ai-sdk' }),
      tools: tools(),
    });
    const denied = await toolApproval({
      toolCall: {
        toolName: 'publish_post',
        input: { id: 'p1', subject: adminUser, actor: { id: 'admin' } },
      },
    });
    expect(denied).toMatchObject({ type: 'denied' });
  });

  it('denies when the data resolver throws or returns nothing', async () => {
    const { toolApproval } = createPermDock(policy, {
      subject: () => memberUser,
      tools: {
        delete_post: {
          permission: permissions.post.delete,
          data: () => {
            throw new Error('boom');
          },
        },
        missing: {
          permission: permissions.post.delete,
          data: () => undefined,
        },
      },
    });
    expect(
      await toolApproval({
        toolCall: { toolName: 'delete_post', input: { id: 'p1' } },
      }),
    ).toEqual({
      type: 'denied',
      reason: 'Denied: delete_post failed closed.',
    });
    expect(
      await toolApproval({
        toolCall: { toolName: 'missing', input: {} },
      }),
    ).toMatchObject({ type: 'denied' });
  });

  it('narrows tools before the model sees them', async () => {
    const { capabilityMiddleware } = createPermDock(policy, {
      subject: () => memberUser,
      tools: tools(),
    });
    const next = await capabilityMiddleware.transformParams({
      params: {
        tools: {
          delete_post: { description: 'delete' },
          list_posts: { description: 'list' },
          publish_post: { description: 'publish' },
          explode: { description: 'nope' },
        },
      },
    });
    expect(Object.keys(next.tools ?? {})).toEqual([
      'delete_post',
      'list_posts',
    ]);
  });

  it('returns a WorkflowAgent predicate that pauses unless granted', async () => {
    const { needsApproval } = createPermDock(policy, {
      subject: () => memberUser,
      actor: () => ({ id: 'agent-1', kind: 'ai-sdk' }),
      tools: tools(),
    });
    expect(await needsApproval(permissions.post.list)({})).toBe(false);
    expect(await needsApproval(permissions.post.delete)({ id: 'p1' })).toBe(
      true,
    );
    expect(await needsApproval(permissions.post.publish)({ id: 'p1' })).toBe(
      true,
    );
  });

  it('treats a thrown subject as anonymous', async () => {
    const { toolApproval } = createPermDock(policy, {
      subject: () => {
        throw new Error('no session');
      },
      tools: tools(),
    });
    const denied = await toolApproval({
      toolCall: { toolName: 'list_posts', input: {} },
    });
    expect(denied).toMatchObject({ type: 'denied' });
  });
});
