import type { Policy } from 'permdock';

import { createPermDock } from 'permdock/claude-agent';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const { canUseTool, permissionRequestHook } = createPermDock(
  policy as Policy,
  {
    subject: () => memberUser,
    actor: () => ({ id: 'claude', kind: 'claude-agent' }),
    tools: {
      delete_post: {
        permission: permissions.post.delete,
        data: () => ownPost,
      },
    },
  },
);

export async function askDelete() {
  const result = await canUseTool('delete_post', { id: ownPost.id });
  return result;
}
