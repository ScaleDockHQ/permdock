import { describe, expect, it } from 'vitest';

import type { ApprovalStore } from '../../src/approvals/types.ts';
import type {
  EveApprovalContext,
  EveResponseContext,
} from '../../src/eve/index.ts';

import { memoryApprovalStore } from '../../src/approvals/index.ts';
import {
  actorFromSession,
  createPermDock,
  rolesOf,
} from '../../src/eve/create.ts';
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

const delegated = { scopes: [permissions.post.delete.scope] };

function principal(id: string, roles: readonly string[]) {
  return {
    principalId: id,
    principalType: 'user',
    authenticator: 'test',
    attributes: { roles },
  };
}

const tools = {
  delete_post: { permission: permissions.post.delete, data: () => ownPost },
};

function ask(callId = 'c1'): EveApprovalContext {
  return {
    session: {
      id: 's1',
      auth: {
        initiator: principal(memberUser.id, memberUser.roles),
        current: principal(memberUser.id, memberUser.roles),
      },
    },
    callId,
    toolName: 'delete_post',
    toolInput: {},
  };
}

function respond(
  responderId: string,
  toolName = 'delete_post',
  callId = 'c1',
): EveResponseContext {
  return {
    request: { callId, requestId: `r-${callId}`, toolName, toolInput: {} },
    response: {
      decision: 'approve',
      principal: { principalId: responderId, attributes: { roles: ['admin'] } },
    },
    session: {
      id: 's1',
      initiator: principal(memberUser.id, memberUser.roles),
    },
  };
}

describe('eve session helpers', () => {
  it('reads roles only from a string or a string array', () => {
    expect([
      rolesOf(principal('u', ['a'])),
      rolesOf({ principalId: 'u', attributes: { roles: 7 } }),
      rolesOf(null),
    ]).toEqual([['a'], [], []]);
  });

  it('names the current principal as actor when it differs from the initiator', () => {
    expect(
      actorFromSession({
        session: {
          id: 's1',
          auth: {
            initiator: principal('u1', []),
            current: principal('agent-7', []),
          },
        },
      }),
    ).toEqual({ id: 'agent-7', kind: 'eve' });
  });
});

describe('permdock/eve responses', () => {
  it('asks an approvers function and rejects a responder it refuses', async () => {
    const seen: string[] = [];
    const { approval } = createPermDock(policy, {
      tools,
      delegation: () => delegated,
      approvers: (responder) => {
        seen.push(responder.principalId);
        return responder.principalId === 'u2';
      },
    });
    await approval.request(ask());
    expect([
      await approval.response(respond('u3')),
      await approval.response(respond('u2')),
      await approval.response(respond('u2')),
    ]).toEqual([
      { status: 'rejected', reason: 'approver is not eligible' },
      { status: 'allowed' },
      expect.objectContaining({ status: 'rejected' }),
    ]);
    expect(seen).toEqual(['u3', 'u2', 'u2']);
  });

  it('rejects when the responder maps to no principal', async () => {
    const { approval } = createPermDock(policy, {
      tools,
      delegation: () => delegated,
      subject: (context) => {
        const id = context.session?.auth?.initiator?.principalId;
        return id === memberUser.id ? memberUser : null;
      },
    });
    await approval.request(ask());
    expect(await approval.response(respond('u2'))).toEqual({
      status: 'rejected',
      reason: 'approver is not eligible',
    });
  });

  it('recomputes the token for an unknown call and rejects an unmapped tool', async () => {
    const { approval } = createPermDock(policy, {
      tools,
      delegation: () => delegated,
    });
    await approval.request({
      callId: 'c1',
      toolName: 'delete_post',
      toolInput: {},
    });
    expect([
      await approval.response(respond('u2', 'unknown_tool', 'c7')),
      await approval.response(respond('u2', 'delete_post', 'c8')),
    ]).toEqual([
      { status: 'rejected', reason: 'approval-not-found' },
      { status: 'rejected', reason: 'approval-not-found' },
    ]);
  });

  it('treats a failing store as approval-not-found', async () => {
    const memory = memoryApprovalStore();
    const failingGet: ApprovalStore = {
      ...memory,
      get: async () => {
        throw new Error('store down');
      },
    };
    const failingResolve: ApprovalStore = {
      ...memory,
      resolve: async () => {
        throw new Error('store down');
      },
    };
    const results = [];
    for (const store of [failingGet, failingResolve]) {
      const { approval } = createPermDock(policy, {
        tools,
        delegation: () => delegated,
        store,
      });
      await approval.request(ask(`c-${String(results.length)}`));
      results.push(
        await approval.response(
          respond('u2', 'delete_post', `c-${String(results.length)}`),
        ),
      );
    }
    expect(results).toEqual([
      { status: 'rejected', reason: 'approval-not-found' },
      { status: 'rejected', reason: 'approval-not-found' },
    ]);
  });
});
