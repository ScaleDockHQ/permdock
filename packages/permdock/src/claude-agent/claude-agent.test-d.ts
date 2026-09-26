import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  Options,
} from '@anthropic-ai/claude-agent-sdk';

import { describe, expectTypeOf, it } from 'vitest';

import { memberUser, permissions, policy } from '../fixtures/quick-start.ts';
import { createPermDock } from './index.ts';

const { canUseTool, permissionRequestHook } = createPermDock(policy, {
  subject: () => memberUser,
  tools: { Read: { permission: permissions.post.read } },
});

describe('permdock/claude-agent against the Claude Agent SDK', () => {
  it('provides a CanUseTool', () => {
    expectTypeOf(canUseTool).toExtend<CanUseTool>();
    expectTypeOf({ canUseTool }).toExtend<Options>();
  });

  it('provides a PermissionRequest HookCallback', () => {
    expectTypeOf(permissionRequestHook).toExtend<HookCallback>();
    expectTypeOf({
      hooks: [permissionRequestHook],
    }).toExtend<HookCallbackMatcher>();
  });
});
