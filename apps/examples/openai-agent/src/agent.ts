import type { Policy } from 'permdock';

import { createPermDock } from 'permdock/openai';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const { needsApproval, guardTools, resolveInterruptions, permdock } =
  createPermDock(policy as Policy, {
    subject: (ctx) => ctx.user ?? memberUser,
    actor: (ctx) => ({ id: ctx.agentId ?? 'openai-1', kind: 'openai' }),
    tools: {
      delete_post: {
        permission: permissions.post.delete,
        data: () => ownPost,
      },
    },
  });

export async function askDelete() {
  const required = await needsApproval(permissions.post.delete)(
    { user: memberUser },
    ownPost,
  );
  return required;
}
