import { describe, expect, it } from 'vitest';

import type {
  OpenAiInterruption,
  OpenAiRunState,
} from '../../src/openai/index.ts';

import { createPermDock } from '../../src/openai/index.ts';
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

function recorder(): OpenAiRunState<OpenAiInterruption> & {
  readonly outcomes: string[];
} {
  const outcomes: string[] = [];
  return {
    outcomes,
    approve(interruption) {
      outcomes.push(`approve:${String(interruption.rawItem?.callId)}`);
    },
    reject(interruption, options) {
      outcomes.push(
        `reject:${String(interruption.rawItem?.callId)}:${options?.message ?? ''}`,
      );
    },
  };
}

describe('permdock/openai edge cases', () => {
  const tools = {
    list_posts: { permission: permissions.post.list },
    update_post: {
      permission: permissions.post.update,
      data: (args: unknown) => (args === 'missing' ? null : ownPost),
    },
    explode: {
      permission: permissions.post.read,
      data: () => {
        throw new Error('loader failed');
      },
    },
  };

  it('reads the call from rawItem and accepts object arguments', async () => {
    const { resolveInterruptions } = createPermDock(policy, {
      subject: () => memberUser,
      tools,
    });
    const run = recorder();
    await resolveInterruptions(
      run,
      [
        {
          type: 'tool_approval_item',
          rawItem: { type: 'function_call', callId: 'a', name: 'list_posts' },
          arguments: undefined,
        },
        {
          type: 'tool_approval_item',
          rawItem: {
            type: 'function_call',
            callId: 'b',
            name: 'update_post',
            arguments: '{"id":"p1"}',
          },
        },
        {
          type: 'tool_approval_item',
          name: 'list_posts',
          rawItem: { type: 'function_call', callId: 'c' },
        },
        {
          type: 'tool_approval_item',
          rawItem: { type: 'function_call', callId: 'd', name: 7 },
        },
      ].map(
        (entry) =>
          // SAFETY: the SDK can hand over items whose arguments are already parsed or missing.
          entry as unknown as OpenAiInterruption,
      ),
      { context: {} },
    );
    expect(run.outcomes).toEqual([
      'reject:a:Denied: unreadable tool call.',
      'approve:b',
      'reject:c:Denied: unreadable tool call.',
      'reject:d:Denied: unreadable tool call.',
    ]);
  });

  it('accepts parsed object arguments on the item', async () => {
    const { resolveInterruptions } = createPermDock(policy, {
      subject: () => memberUser,
      tools,
    });
    const run = recorder();
    // SAFETY: the SDK can hand over items whose arguments are already parsed.
    const parsed = {
      type: 'tool_approval_item',
      name: 'update_post',
      arguments: { id: 'p1' },
      rawItem: { type: 'function_call', callId: 'e' },
    } as unknown as OpenAiInterruption;
    await resolveInterruptions(run, [parsed], { context: {} });
    expect(run.outcomes).toEqual(['approve:e']);
  });

  it('pauses for an unbound permission, a missing row and a throwing loader', async () => {
    const { needsApproval } = createPermDock(policy, {
      subject: () => memberUser,
      tools,
    });
    expect([
      await needsApproval(permissions.post.publish)(undefined, {}),
      await needsApproval(permissions.post.update)({ context: 'x' }, 'missing'),
      await needsApproval(permissions.post.read)(undefined, {}),
      await needsApproval(permissions.post.update)(undefined, {}),
    ]).toEqual([true, true, true, false]);
  });
});
