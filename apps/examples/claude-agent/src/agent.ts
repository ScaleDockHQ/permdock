import { memoryApprovalStore } from 'permdock/approvals';
import { createPermDock } from 'permdock/claude-agent';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const store = memoryApprovalStore();

export const { canUseTool, permissionRequestHook } = createPermDock(policy, {
  subject: () => memberUser,
  store,
  actor: () => ({ id: 'claude', kind: 'claude-agent' }),
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

export async function askDelete() {
  const result = await canUseTool('delete_post', { id: ownPost.id });
  return result;
}
