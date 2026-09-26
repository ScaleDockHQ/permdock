import { createPermDock } from 'permdock/openai';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const { needsApproval, guardTools, resolveInterruptions, permdock } =
  createPermDock(policy, {
    subject: (ctx) => ctx.user ?? memberUser,
    actor: (ctx) => ({ id: ctx.agentId ?? 'openai-1', kind: 'openai' }),
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
  const required = await needsApproval(permissions.post.delete)(
    { context: { user: memberUser } },
    ownPost,
  );
  return required;
}
