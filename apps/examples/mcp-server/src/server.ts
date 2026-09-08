import type { Policy } from 'permdock';

import { createPermDock } from 'permdock/mcp';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

const { protectServer } = createPermDock(policy as Policy, {
  subject: () => memberUser,
});

export const tools = new Map<
  string,
  {
    readonly config: Readonly<Record<string, unknown>>;
    readonly handler: (args: unknown, extra?: unknown) => unknown;
  }
>();

const server = {
  registerTool(
    name: string,
    config: Readonly<Record<string, unknown>>,
    handler: (args: unknown, extra?: unknown) => unknown,
  ): void {
    tools.set(name, { config, handler });
  },
};

export const guarded = protectServer(server);

guarded.registerTool(
  'list_posts',
  { permission: permissions.post.list },
  () => ({ content: [{ type: 'text', text: '[]' }] }),
);

guarded.registerTool(
  'update_post',
  {
    permission: permissions.post.update,
    data: () => ownPost,
  },
  () => ({ content: [{ type: 'text', text: 'updated' }] }),
);

guarded.registerTool(
  'delete_post',
  {
    permission: permissions.post.delete,
    data: () => ownPost,
  },
  () => ({ content: [{ type: 'text', text: 'deleted' }] }),
);
