import { describe, expect, it } from 'vitest';

import { memoryApprovalStore } from '../approvals/index.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { createPermDock } from './index.ts';

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

describe('permdock/claude-agent', () => {
  it('allows granted tools and denies unmapped or unpublished ones', async () => {
    const { canUseTool } = createPermDock(policy, {
      subject: () => memberUser,
      actor: () => ({ id: 'claude-agent', kind: 'claude-agent' }),
      tools: tools(),
    });

    const allowed = await canUseTool('Read', { file_path: '/posts/p1' });
    expect(allowed).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/posts/p1' },
    });

    const denied = await canUseTool('Publish', {});
    expect(denied).toMatchObject({ behavior: 'deny' });
    if (denied !== null && denied.behavior === 'deny') {
      expect(denied.message).toContain('post.publish');
    }

    const unmapped = await canUseTool('Bash', { command: 'rm -rf /' });
    expect(unmapped).toEqual({
      behavior: 'deny',
      message: 'Denied: unmapped tool Bash.',
    });
  });

  it('defers approval-required calls and binds the resume token', async () => {
    const store = memoryApprovalStore();
    const { canUseTool, permissionRequestHook } = createPermDock(policy, {
      subject: () => memberUser,
      actor: () => ({ id: 'claude-agent', kind: 'claude-agent' }),
      tools: tools(),
      store,
    });

    expect(
      await canUseTool('mcp__posts__delete_post', { id: 'p1' }),
    ).toBeNull();

    const asked = await permissionRequestHook({
      tool_name: 'mcp__posts__delete_post',
      tool_input: { id: 'p1' },
    });
    expect(asked.token).toEqual(expect.any(String));
    expect(asked.additionalContext).toContain('Token:');
    expect(asked.hookSpecificOutput.decision).toBeUndefined();

    const token = asked.token;
    if (token === undefined) {
      throw new Error('expected token');
    }
    await store.resolve(token, {
      status: 'approved',
      by: { principal: { id: 'u2', roles: ['admin'] }, context: {} },
    });

    expect(
      await canUseTool('mcp__posts__delete_post', { id: 'p1' }, { token }),
    ).toEqual({
      behavior: 'allow',
      updatedInput: { id: 'p1' },
    });

    const tampered = await permissionRequestHook({
      tool_name: 'mcp__posts__delete_post',
      tool_input: { id: 'p2' },
      token,
    });
    expect(tampered.hookSpecificOutput.decision).toMatchObject({
      behavior: 'deny',
    });
  });

  it('ignores a subject smuggled in tool input', async () => {
    const { canUseTool } = createPermDock(policy, {
      subject: () => memberUser,
      tools: tools(),
    });
    const denied = await canUseTool('Publish', {
      subject: adminUser,
    });
    expect(denied).toMatchObject({ behavior: 'deny' });
  });
});
