import type { Policy } from 'permdock';

import { createPermDock } from 'permdock/ai-sdk';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const { toolApproval, capabilityMiddleware, needsApproval } =
  createPermDock(policy as Policy, {
    subject: () => memberUser,
    actor: () => ({ id: 'agent-1', kind: 'ai-sdk' }),
    tools: {
      delete_post: {
        permission: permissions.post.delete,
        data: () => ownPost,
      },
    },
  });

export async function approveDelete() {
  const status = await toolApproval({
    toolCall: { toolName: 'delete_post', input: { id: ownPost.id } },
  });
  return status;
}
