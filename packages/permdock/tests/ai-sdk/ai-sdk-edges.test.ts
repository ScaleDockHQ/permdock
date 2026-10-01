import { describe, expect, it } from 'vitest';

import { createPermDock } from '../../src/ai-sdk/index.ts';
import { PermDockApprovalRequiredError } from '../../src/core/errors.ts';
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

function dock() {
  return createPermDock(policy, {
    subject: () => memberUser,
    tools: {
      delete_post: { permission: permissions.post.delete, data: () => ownPost },
    },
  });
}

describe('permdock/ai-sdk edge cases', () => {
  it('leaves params without tools unchanged', async () => {
    const params = { toolChoice: 'auto' };
    expect(
      await dock().capabilityMiddleware({}).transformParams({ params }),
    ).toBe(params);
  });

  it('asks for approval unless the messages already carry the request', async () => {
    const { needsApproval } = dock();
    const check = needsApproval(permissions.post.delete);
    const unrelated = [
      null,
      'text',
      { role: 'user', content: [] },
      { role: 'assistant', content: 'plain' },
      {
        role: 'assistant',
        content: [null, { type: 'tool-approval-request', toolCallId: 'other' }],
      },
    ];
    expect(
      await check(ownPost, { toolCallId: 'c1', messages: unrelated }),
    ).toBe(true);
    expect(await check(ownPost, { messages: unrelated })).toBe(true);
    const recheck = check(ownPost, {
      toolCallId: 'c1',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-approval-request', toolCallId: 'c1' }],
        },
      ],
    });
    await expect(recheck).rejects.toBeInstanceOf(PermDockApprovalRequiredError);
    await expect(recheck).rejects.toMatchObject({
      resource: { type: 'post', id: 'p1' },
    });
  });
});
