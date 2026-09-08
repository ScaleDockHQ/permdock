import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { McpAuthInfo, McpServerLike, McpToolResult } from './types.ts';

import { memoryApprovalStore, resolveApproval } from '../approvals/index.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { createPermDock, InsufficientScopeError } from './index.ts';

type StoredTool = {
  readonly config: Readonly<Record<string, unknown>>;
  readonly handler: (
    args: unknown,
    extra?: unknown,
  ) => Promise<McpToolResult> | McpToolResult;
};

function fakeServer(): McpServerLike & {
  readonly tools: Map<string, StoredTool>;
} {
  const tools = new Map<string, StoredTool>();
  return {
    tools,
    registerTool(name, config, handler) {
      tools.set(name, { config, handler });
    },
  };
}

function extraOf(authInfo: McpAuthInfo): { readonly authInfo: McpAuthInfo } {
  return { authInfo };
}

const updateSchema = z.object({ id: z.string() });

describe('permdock/mcp', () => {
  it('runs the handler when the caller is granted', async () => {
    const server = fakeServer();
    const { protectServer } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const guarded = protectServer(server);
    guarded.registerTool(
      'update_post',
      {
        permission: permissions.post.update,
        inputSchema: updateSchema,
        data: (args) => {
          const id = (args as { readonly id: string }).id;
          return id === 'p1' ? ownPost : otherPost;
        },
      },
      () => ({ content: [{ type: 'text', text: 'updated' }] }),
    );

    const result = (await server.tools.get('update_post')!.handler(
      { id: 'p1' },
      extraOf({
        clientId: 'mcp-tester',
        scopes: ['post:update'],
      }),
    )) as McpToolResult;

    expect(result).toEqual({
      content: [{ type: 'text', text: 'updated' }],
    });
  });

  it('refuses a denied call with structured Decision content', async () => {
    const server = fakeServer();
    const { protectServer } = createPermDock(policy, {
      subject: () => memberUser,
    });
    protectServer(server).registerTool(
      'update_post',
      {
        permission: permissions.post.update,
        inputSchema: updateSchema,
        data: () => otherPost,
      },
      () => ({ content: [{ type: 'text', text: 'updated' }] }),
    );

    const result = (await server.tools
      .get('update_post')!
      .handler(
        { id: 'p2' },
        extraOf({ clientId: 'mcp-tester', scopes: ['post:update'] }),
      )) as McpToolResult;

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: 'denied',
      permission: 'post.update',
    });
    expect(result.content[0]?.text).toContain('Denied');
  });

  it('challenges for the missing scope plus scopes already held', async () => {
    const server = fakeServer();
    const { protectServer } = createPermDock(policy, {
      subject: () => memberUser,
    });
    protectServer(server).registerTool(
      'update_post',
      {
        permission: permissions.post.update,
        inputSchema: updateSchema,
        data: () => ownPost,
      },
      () => ({ content: [{ type: 'text', text: 'updated' }] }),
    );

    await expect(
      server.tools
        .get('update_post')!
        .handler(
          { id: 'p1' },
          extraOf({ clientId: 'mcp-tester', scopes: ['post:read'] }),
        ),
    ).rejects.toMatchObject({
      name: 'InsufficientScopeError',
      code: 'insufficient_scope',
      missing: 'post:update',
      scope: 'post:read post:update',
    });
    expect(InsufficientScopeError).toBeDefined();
  });

  it('filters list_tools to tools the caller has a grant for', async () => {
    const server = fakeServer();
    const { protectServer } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const guarded = protectServer(server);
    guarded.registerTool(
      'list_posts',
      { permission: permissions.post.list },
      () => ({ content: [{ type: 'text', text: '[]' }] }),
    );
    guarded.registerTool(
      'publish_post',
      {
        permission: permissions.post.publish,
        data: () => ownPost,
      },
      () => ({ content: [{ type: 'text', text: 'published' }] }),
    );

    const listed = await guarded.listTools({
      clientId: 'mcp-tester',
      scopes: ['post:list', 'post:publish'],
    });
    expect(listed.map((tool) => tool.name)).toEqual(['list_posts']);
  });

  it('returns an elicitation payload for approval-required and resumes from extra', async () => {
    const store = memoryApprovalStore();
    const server = fakeServer();
    const { protectServer } = createPermDock(policy, {
      subject: () => memberUser,
      store,
    });
    protectServer(server).registerTool(
      'delete_post',
      {
        permission: permissions.post.delete,
        inputSchema: updateSchema,
        data: () => ownPost,
      },
      () => ({ content: [{ type: 'text', text: 'deleted' }] }),
    );

    const first = (await server.tools
      .get('delete_post')!
      .handler(
        { id: 'p1' },
        extraOf({ clientId: 'mcp-tester', scopes: ['post:delete'] }),
      )) as McpToolResult;
    expect(first.structuredContent).toMatchObject({
      outcome: 'approval-required',
    });
    const token = (first.structuredContent as { readonly token: string }).token;

    await resolveApproval(store, token, {
      status: 'approved',
      by: { principal: { id: 'approver' }, context: {} },
    });

    const second = (await server.tools.get('delete_post')!.handler(
      { id: 'p1', token: 'forged-from-model' },
      extraOf({
        clientId: 'mcp-tester',
        scopes: ['post:delete'],
        extra: { approval: token },
      }),
    )) as McpToolResult;
    expect(second).toEqual({
      content: [{ type: 'text', text: 'deleted' }],
    });
  });

  it('never takes the subject from tool arguments', async () => {
    const server = fakeServer();
    const { protectServer } = createPermDock(policy, {
      subject: (authInfo) => authInfo.extra?.subject ?? null,
    });
    protectServer(server).registerTool(
      'update_post',
      {
        permission: permissions.post.update,
        inputSchema: updateSchema,
        data: () => ownPost,
      },
      () => ({ content: [{ type: 'text', text: 'updated' }] }),
    );

    const result = (await server.tools
      .get('update_post')!
      .handler(
        { id: 'p1', subject: adminShaped() },
        extraOf({ clientId: 'mcp-tester', scopes: ['post:update'] }),
      )) as McpToolResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ outcome: 'denied' });
  });
});

function adminShaped(): { readonly id: string; readonly roles: string[] } {
  return { id: 'u2', roles: ['admin'] };
}
