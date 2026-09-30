import { describe, expect, it } from 'vitest';

import { memoryApprovalStore } from '../../src/approvals/index.ts';
import { createPermDock } from '../../src/claude-agent/index.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

const delegated = {
  scopes: [
    permissions.post.read.scope,
    permissions.post.list.scope,
    permissions.post.delete.scope,
    permissions.post.publish.scope,
  ],
};

function tools() {
  return {
    mcp__posts__delete_post: {
      permission: permissions.post.delete,
      data: (args: unknown) => {
        const id = (args as { readonly id?: string }).id;
        return id === 'p1' ? ownPost : otherPost;
      },
    },
    Read: { permission: permissions.post.read, data: () => ownPost },
    Publish: {
      permission: permissions.post.publish,
      data: () => ownPost,
    },
  };
}

const signal = new AbortController().signal;
const sdkServer = { signal, mcpServer: { name: 'posts', source: 'sdk' } };

function hookInput(toolName: string, toolInput: unknown, mcpServer?: unknown) {
  return {
    hook_event_name: 'PermissionRequest' as const,
    session_id: 's1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    tool_name: toolName,
    tool_input: toolInput,
    ...(mcpServer === undefined ? {} : { mcp_server: mcpServer }),
  };
}

describe('permdock/claude-agent', () => {
  it('allows granted tools and denies unmapped or unpublished ones', async () => {
    const { canUseTool } = createPermDock(policy, {
      subject: () => memberUser,
      delegation: () => delegated,
      actor: () => ({ id: 'claude-agent', kind: 'claude-agent' }),
      tools: tools(),
    });

    const allowed = await canUseTool(
      'Read',
      { file_path: '/posts/p1' },
      { signal },
    );
    expect(allowed).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/posts/p1' },
    });

    const denied = await canUseTool('Publish', {}, { signal });
    expect(denied.behavior).toBe('deny');
    if (denied.behavior === 'deny') {
      expect(denied.message).toContain('post.publish');
    }

    const unmapped = await canUseTool(
      'Bash',
      { command: 'rm -rf /' },
      { signal },
    );
    expect(unmapped).toEqual({
      behavior: 'deny',
      message: 'Denied: unmapped tool Bash.',
    });
  });

  it('denies an approval-required call with the pending token, then allows it once approved', async () => {
    const store = memoryApprovalStore();
    const { canUseTool } = createPermDock(policy, {
      subject: () => memberUser,
      delegation: () => delegated,
      actor: () => ({ id: 'claude-agent', kind: 'claude-agent' }),
      tools: tools(),
      store,
    });

    const parked = await canUseTool(
      'mcp__posts__delete_post',
      { id: 'p1' },
      sdkServer,
    );
    expect(parked.behavior).toBe('deny');
    const [pending] = (await store.list({ status: 'pending' })).items;
    if (pending === undefined || parked.behavior !== 'deny') {
      throw new Error('expected a pending approval');
    }
    expect(parked.message).toContain(pending.token);

    await store.resolve(pending.token, {
      status: 'approved',
      by: { principal: { id: 'u2', roles: ['admin'] }, context: {} },
    });
    expect(
      await canUseTool('mcp__posts__delete_post', { id: 'p1' }, sdkServer),
    ).toEqual({ behavior: 'allow', updatedInput: { id: 'p1' } });
    expect(
      (await canUseTool('mcp__posts__delete_post', { id: 'p1' }, sdkServer))
        .behavior,
    ).toBe('deny');
  });

  it('trusts mcp__ tools only from the configured server sources', async () => {
    const { canUseTool } = createPermDock(policy, {
      subject: () => adminUser,
      tools: tools(),
    });
    expect(
      (await canUseTool('mcp__posts__delete_post', { id: 'p2' }, sdkServer))
        .behavior,
    ).toBe('allow');
    const project = await canUseTool(
      'mcp__posts__delete_post',
      { id: 'p2' },
      { signal, mcpServer: { name: 'posts', source: 'project' } },
    );
    expect(project).toMatchObject({ behavior: 'deny' });
    const unlabelled = await canUseTool(
      'mcp__posts__delete_post',
      { id: 'p2' },
      { signal },
    );
    expect(unlabelled).toMatchObject({ behavior: 'deny' });
    const renamed = await canUseTool(
      'mcp__posts__delete_post',
      { id: 'p2' },
      { signal, mcpServer: { name: 'other', source: 'sdk' } },
    );
    expect(renamed).toMatchObject({ behavior: 'deny' });

    const plugins = createPermDock(policy, {
      subject: () => adminUser,
      tools: tools(),
      mcpSources: ['plugin'],
    });
    expect(
      (
        await plugins.canUseTool(
          'mcp__posts__delete_post',
          { id: 'p2' },
          { signal, mcpServer: { name: 'posts', source: 'plugin' } },
        )
      ).behavior,
    ).toBe('allow');
  });

  it('answers the PermissionRequest hook and ignores other events', async () => {
    const { permissionRequestHook } = createPermDock(policy, {
      subject: () => memberUser,
      tools: tools(),
    });
    expect(
      await permissionRequestHook(
        hookInput('Read', { file_path: '/p1' }),
        't1',
        {
          signal,
        },
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { file_path: '/p1' } },
      },
    });
    const parked = await permissionRequestHook(
      hookInput(
        'mcp__posts__delete_post',
        { id: 'p1' },
        {
          name: 'posts',
          source: 'sdk',
        },
      ),
      't2',
      { signal },
    );
    expect(parked).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'deny' } },
    });
    const tampered = await permissionRequestHook(
      hookInput(
        'mcp__posts__delete_post',
        { id: 'p2' },
        {
          name: 'posts',
          source: 'user',
        },
      ),
      't3',
      { signal },
    );
    expect(tampered).toMatchObject({
      hookSpecificOutput: { decision: { behavior: 'deny' } },
    });
    expect(
      await permissionRequestHook(
        { hook_event_name: 'Stop', session_id: 's1' },
        undefined,
        { signal },
      ),
    ).toEqual({});
  });

  it('ignores a subject smuggled in tool input', async () => {
    const { canUseTool } = createPermDock(policy, {
      subject: () => memberUser,
      tools: tools(),
    });
    const denied = await canUseTool(
      'Publish',
      { subject: adminUser },
      { signal },
    );
    expect(denied).toMatchObject({ behavior: 'deny' });
  });
});
