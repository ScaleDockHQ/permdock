import type { Policy } from 'permdock';

import { createPermDock } from 'permdock/eve';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const { approval, approvalFor, permdock } = createPermDock(
  policy as Policy,
  {
    subject: () => memberUser,
    actor: () => ({ id: 'eve-1', kind: 'eve' }),
    tools: {
      delete_post: {
        permission: permissions.post.delete,
        data: () => ownPost,
      },
    },
  },
);

export async function askDelete() {
  const result = await approval.request(
    {},
    { toolName: 'delete_post', toolInput: { id: ownPost.id } },
  );
  return result;
}
