import { describe, expect, it } from 'vitest';

import type { OpenAiInterruption, OpenAiRunState } from './index.ts';

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
      data: () => ownPost,
    },
  };
}

function state(): OpenAiRunState & {
  readonly approved: string[];
  readonly rejected: { readonly id: string; readonly message?: string }[];
} {
  const approved: string[] = [];
  const rejected: { readonly id: string; readonly message?: string }[] = [];
  return {
    approved,
    rejected,
    approve(interruption: OpenAiInterruption): void {
      approved.push(interruption.callId);
    },
    reject(
      interruption: OpenAiInterruption,
      options?: { readonly message?: string },
    ): void {
      rejected.push({ id: interruption.callId, message: options?.message });
    },
  };
}

describe('permdock/openai', () => {
  it('pauses unless granted and auto-rejects denials', async () => {
    const { needsApproval, resolveInterruptions, permdock } = createPermDock(
      policy,
      {
        subject: (context) => context.user,
        actor: (context) => ({
          id: typeof context.agentId === 'string' ? context.agentId : 'agent',
          kind: 'openai-agent',
        }),
        tools: tools(),
      },
    );
    const context = { user: memberUser, agentId: 'agent-1' };
    expect(await needsApproval(permissions.post.list)(context, {})).toBe(false);
    expect(
      await needsApproval(permissions.post.delete)(context, { id: 'p1' }),
    ).toBe(true);
    expect(
      await needsApproval(permissions.post.publish)(context, { id: 'p1' }),
    ).toBe(true);
    expect((await permdock(context)).subject.actor?.kind).toBe('openai-agent');

    const run = state();
    const pending = await resolveInterruptions(
      run,
      [
        {
          callId: 'deny-1',
          rawItem: { name: 'publish_post', arguments: { id: 'p1' } },
        },
      ],
      { context },
    );
    expect(pending).toEqual([]);
    expect(run.rejected[0]?.id).toBe('deny-1');
    expect(run.rejected[0]?.message).toContain('post.publish');
  });

  it('records approval-required interruptions and rejects a token mismatch', async () => {
    const store = memoryApprovalStore();
    const { needsApproval, resolveInterruptions } = createPermDock(policy, {
      subject: (context) => context.user,
      actor: () => ({ id: 'agent-1', kind: 'openai-agent' }),
      tools: tools(),
      store,
    });
    const context = { user: memberUser };
    expect(
      await needsApproval(permissions.post.delete)(context, { id: 'p1' }),
    ).toBe(true);

    const run = state();
    const pending = await resolveInterruptions(
      run,
      [
        {
          callId: 'c1',
          rawItem: { name: 'delete_post', arguments: { id: 'p1' } },
        },
      ],
      { context },
    );
    expect(pending).toHaveLength(1);
    const token = pending[0]?.token;
    if (token === undefined) {
      throw new Error('expected token');
    }

    await store.resolve(token, {
      status: 'approved',
      by: { principal: { id: 'u2', roles: ['admin'] }, context: {} },
    });

    const resumed = state();
    await resolveInterruptions(
      resumed,
      [
        {
          callId: 'c1',
          rawItem: { name: 'delete_post', arguments: { id: 'p1' } },
        },
      ],
      { context },
    );
    expect(resumed.approved).toEqual(['c1']);

    const tampered = state();
    await resolveInterruptions(
      tampered,
      [
        {
          callId: 'c1',
          rawItem: { name: 'delete_post', arguments: { id: 'p2' } },
        },
      ],
      { context },
    );
    expect(tampered.rejected[0]?.message).toMatch(/approval|denied/u);
  });

  it('hides tools with no grant and ignores a subject in arguments', async () => {
    const { guardTools, needsApproval } = createPermDock(policy, {
      subject: (context) => context.user,
      tools: tools(),
    });
    const context = { user: memberUser };
    const guarded = await guardTools(
      [
        { name: 'delete_post' },
        { name: 'list_posts' },
        { name: 'publish_post' },
        { name: 'explode' },
      ],
      context,
    );
    expect(guarded.map((tool) => tool.name)).toEqual([
      'delete_post',
      'list_posts',
    ]);
    expect(
      await needsApproval(permissions.post.publish)(context, {
        id: 'p1',
        subject: adminUser,
      }),
    ).toBe(true);
  });
});
