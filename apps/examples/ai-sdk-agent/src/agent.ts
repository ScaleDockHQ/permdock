import { createPermDock } from 'permdock/ai-sdk';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const { toolApproval, capabilityMiddleware, needsApproval } =
  createPermDock(policy, {
    subject: () => memberUser,
    actor: () => ({ id: 'agent-1', kind: 'ai-sdk' }),
    delegation: () => ({
      scopes: [permissions.post.list.scope, permissions.post.delete.scope],
    }),
    tools: {
      list_posts: {
        permission: permissions.post.list,
      },
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
