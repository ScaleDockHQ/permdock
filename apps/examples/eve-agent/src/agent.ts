import type { EveApprovalContext, EvePrincipal } from 'permdock/eve';

import { memoryApprovalStore } from 'permdock/approvals';
import { createPermDock } from 'permdock/eve';

import { ownPost, permissions } from './permissions.ts';
import { adminUser, memberUser, policy, userById } from './policy.ts';

export const initiator: EvePrincipal = {
  principalId: memberUser.id,
  principalType: 'user',
  attributes: { roles: [...memberUser.roles] },
};

export const reviewer: EvePrincipal = {
  principalId: adminUser.id,
  principalType: 'user',
  attributes: { roles: [...adminUser.roles] },
};

export const { approval, approvalFor, permdock } = createPermDock(policy, {
  subject: ({ session }) => userById(session?.auth?.initiator?.principalId),
  store: memoryApprovalStore(),
  approvers: { roles: ['admin'] },
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

export function callContext(
  sessionId: string,
  callId: string,
  toolName: string,
  toolInput: unknown,
): EveApprovalContext {
  return {
    session: { id: sessionId, auth: { initiator, current: initiator } },
    callId,
    toolName,
    toolInput,
  };
}

export async function approve(
  sessionId: string,
  callId: string,
  toolName: string,
) {
  const result = await approval.response({
    request: { callId, toolName, toolInput: { id: ownPost.id } },
    responder: reviewer,
    session: { id: sessionId, initiator },
  });
  return result;
}
