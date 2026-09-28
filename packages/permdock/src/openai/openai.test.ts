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

const delegated = {
  scopes: [
    permissions.post.read.scope,
    permissions.post.list.scope,
    permissions.post.delete.scope,
    permissions.post.publish.scope,
  ],
};

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

function item(callId: string, name: string, args: unknown): OpenAiInterruption {
  return {
    type: 'tool_approval_item',
    name,
    arguments: JSON.stringify(args),
    rawItem: {
      type: 'function_call',
      callId,
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function idOf(interruption: OpenAiInterruption): string {
  return String(interruption.rawItem?.callId);
}

function state(): OpenAiRunState<OpenAiInterruption> & {
  readonly approved: string[];
  readonly rejected: { readonly id: string; readonly message?: string }[];
} {
  const approved: string[] = [];
  const rejected: { readonly id: string; readonly message?: string }[] = [];
  return {
    approved,
    rejected,
    approve(interruption: OpenAiInterruption): void {
      approved.push(idOf(interruption));
    },
    reject(
      interruption: OpenAiInterruption,
      options?: { readonly message?: string },
    ): void {
      rejected.push({ id: idOf(interruption), message: options?.message });
    },
  };
}

function runContext<T>(context: T): { readonly context: T } {
  return { context };
}

describe('permdock/openai', () => {
  it('pauses unless granted and auto-rejects denials', async () => {
    const { needsApproval, resolveInterruptions, permdock } = createPermDock(
      policy,
      {
        subject: (context) => context.user,
        delegation: () => delegated,
        actor: (context) => ({
          id: typeof context.agentId === 'string' ? context.agentId : 'agent',
          kind: 'openai-agent',
        }),
        tools: tools(),
      },
    );
    const context = { user: memberUser, agentId: 'agent-1' };
    expect(
      await needsApproval(permissions.post.list)(runContext(context), {}),
    ).toBe(false);
    expect(
      await needsApproval(permissions.post.delete)(runContext(context), {
        id: 'p1',
      }),
    ).toBe(true);
    expect(
      await needsApproval(permissions.post.publish)(runContext(context), {
        id: 'p1',
      }),
    ).toBe(true);
    expect((await permdock(context)).subject.actor?.kind).toBe('openai-agent');

    const run = state();
    const pending = await resolveInterruptions(
      run,
      [item('deny-1', 'publish_post', { id: 'p1' })],
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
      delegation: () => delegated,
      actor: () => ({ id: 'agent-1', kind: 'openai-agent' }),
      tools: tools(),
      store,
    });
    const context = { user: memberUser };
    expect(
      await needsApproval(permissions.post.delete)(runContext(context), {
        id: 'p1',
      }),
    ).toBe(true);

    const run = state();
    const pending = await resolveInterruptions(
      run,
      [item('c1', 'delete_post', { id: 'p1' })],
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
      [item('c1', 'delete_post', { id: 'p1' })],
      { context },
    );
    expect(resumed.approved).toEqual(['c1']);

    const tampered = state();
    await resolveInterruptions(
      tampered,
      [item('c1', 'delete_post', { id: 'p2' })],
      { context },
    );
    expect(tampered.rejected[0]?.message).toMatch(/approval|denied/u);
  });

  it('resumes from the shared store in a fresh instance, once', async () => {
    const store = memoryApprovalStore();
    const options = {
      subject: (context: { readonly user?: unknown }) => context.user,
      delegation: () => delegated,
      actor: () => ({ id: 'agent-1', kind: 'openai-agent' }),
      tools: tools(),
      store,
    };
    const context = { user: memberUser };
    const first = createPermDock(policy, options);
    const [pending] = await first.resolveInterruptions(
      state(),
      [item('c1', 'delete_post', { id: 'p1' })],
      { context },
    );
    if (pending === undefined) {
      throw new Error('expected a pending approval');
    }
    await store.resolve(pending.token, {
      status: 'approved',
      by: { principal: { id: 'u2', roles: ['admin'] }, context: {} },
    });

    const second = createPermDock(policy, options);
    const resumed = state();
    await second.resolveInterruptions(
      resumed,
      [item('c1', 'delete_post', { id: 'p1' })],
      { context },
    );
    expect(resumed.approved).toEqual(['c1']);

    const replayed = state();
    await second.resolveInterruptions(
      replayed,
      [item('c1', 'delete_post', { id: 'p1' })],
      { context },
    );
    expect(replayed.approved).toEqual([]);
    expect(replayed.rejected[0]?.message).toMatch(/consumed|denied/u);
  });

  it('rejects a rejected approval and unparseable arguments', async () => {
    const store = memoryApprovalStore();
    const { resolveInterruptions } = createPermDock(policy, {
      subject: (context) => context.user,
      tools: tools(),
      store,
    });
    const context = { user: memberUser };
    const [pending] = await resolveInterruptions(
      state(),
      [item('c1', 'delete_post', { id: 'p1' })],
      { context },
    );
    if (pending === undefined) {
      throw new Error('expected a pending approval');
    }
    await store.resolve(pending.token, {
      status: 'rejected',
      by: { principal: { id: 'u2', roles: ['admin'] }, context: {} },
    });
    const rejected = state();
    await resolveInterruptions(
      rejected,
      [item('c1', 'delete_post', { id: 'p1' })],
      { context },
    );
    expect(rejected.rejected[0]?.message).toMatch(/rejected|denied/u);

    const garbled = state();
    await resolveInterruptions(
      garbled,
      [
        {
          type: 'tool_approval_item',
          rawItem: {
            type: 'function_call',
            callId: 'c2',
            name: 'delete_post',
            arguments: '{not json',
          },
        },
      ],
      { context },
    );
    expect(garbled.rejected[0]?.id).toBe('c2');
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
      await needsApproval(permissions.post.publish)(runContext(context), {
        id: 'p1',
        subject: adminUser,
      }),
    ).toBe(true);
  });
});
