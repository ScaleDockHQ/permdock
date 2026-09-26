import { describe, expect, it, vi } from 'vitest';

import { memoryApprovalStore } from '../approvals/index.ts';
import { PermDockDeniedError } from '../core/errors.ts';
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

  it('narrows tools per subject before the model sees them', async () => {
    const { capabilityMiddleware } = createPermDock(policy, {
      subject: (context) => context.user,
      tools: tools(),
    });
    const params = {
      prompt: [],
      tools: [
        { type: 'function', name: 'delete_post' },
        { type: 'function', name: 'list_posts' },
        { type: 'function', name: 'publish_post' },
        { type: 'function', name: 'explode' },
        { type: 'provider', name: 'web_search' },
      ],
      toolChoice: { type: 'tool', toolName: 'publish_post' },
    };
    const member = await capabilityMiddleware({
      user: memberUser,
    }).transformParams({ params });
    expect(member.tools?.map((tool) => tool.name)).toEqual([
      'delete_post',
      'list_posts',
    ]);
    expect(member.toolChoice).toEqual({ type: 'none' });

    const admin = await capabilityMiddleware({
      user: adminUser,
    }).transformParams({ params });
    expect(admin.tools?.map((tool) => tool.name)).toEqual([
      'delete_post',
      'list_posts',
      'publish_post',
    ]);
    expect(admin.toolChoice).toEqual(params.toolChoice);

    const anonymous = await capabilityMiddleware({}).transformParams({
      params,
    });
    expect(anonymous.tools).toEqual([]);
  });

  it('reads the subject for needsApproval from the tool context', async () => {
    const { needsApproval } = createPermDock(policy, {
      subject: (context) => context.user,
      tools: tools(),
    });
    expect(
      await needsApproval(permissions.post.list)(
        {},
        { toolCallId: 'c1', messages: [], context: { user: memberUser } },
      ),
    ).toBe(false);
    await expect(
      needsApproval(permissions.post.list)({}, { toolCallId: 'c1' }),
    ).rejects.toThrow(PermDockDeniedError);
  });

  it('returns a predicate that pauses for approval and throws when denied', async () => {
    const { needsApproval } = createPermDock(policy, {
      subject: () => memberUser,
      actor: () => ({ id: 'agent-1', kind: 'ai-sdk' }),
      tools: tools(),
    });
    expect(await needsApproval(permissions.post.list)({})).toBe(false);
    expect(await needsApproval(permissions.post.delete)({ id: 'p1' })).toBe(
      true,
    );
    await expect(
      needsApproval(permissions.post.publish)({ id: 'p1' }),
    ).rejects.toThrow(PermDockDeniedError);
    await expect(needsApproval(permissions.post.update)({})).rejects.toThrow(
      PermDockDeniedError,
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
