import type { EveApprovalContext, EvePrincipal } from "permdock/eve";

import { defineOperations, hostedPolicies } from "permdock";
import { createPermDock } from "permdock/eve";

import { backend } from "./cloud.ts";
import { env } from "./env.ts";
import { ownPost, permissions } from "./permissions.ts";
import { adminUser, memberUser, policy, userById } from "./policy.ts";

export const initiator: EvePrincipal = {
  principalId: memberUser.id,
  principalType: "user",
  attributes: { roles: [...memberUser.roles] },
};

export const reviewer: EvePrincipal = {
  principalId: adminUser.id,
  principalType: "user",
  attributes: { roles: [...adminUser.roles] },
};

export const app = backend(env.cloud);

export const { approval, approvalFor, getPermDock } = createPermDock(policy, {
  subject: ({ session }) => userById(session?.auth?.initiator?.principalId),
  store: app.store,
  ...(app.sink === null ? {} : { sink: app.sink }),
  ...(app.policies === null ? {} : { policies: hostedPolicies(app.policies) }),
  approvers: { roles: ["admin"] },
  delegation: () => ({
    scopes: [permissions.post.list.scope, permissions.post.delete.scope],
  }),
  operations: defineOperations(permissions, {
    list_posts: { permission: permissions.post.list },
    delete_post: { permission: permissions.post.delete, data: () => ownPost },
  }),
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
    response: { decision: "approve", principal: reviewer },
    session: { id: sessionId, initiator },
  });
  return result;
}
