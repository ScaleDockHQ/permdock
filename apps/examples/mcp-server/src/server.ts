import { createPermDock } from 'permdock/mcp';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const otelLog: {
  readonly message: string;
  readonly attributes?: Record<string, unknown>;
}[] = [];

const { protectServer } = createPermDock(policy, {
  subject: () => memberUser,
  otel: {
    logger: {
      info(message: string, attributes?: Record<string, unknown>) {
        otelLog.push({ message, attributes });
      },
      warn(message: string, attributes?: Record<string, unknown>) {
        otelLog.push({ message, attributes });
      },
    },
  },
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
