import type {
  Agent,
  FunctionTool,
  RunState,
  RunToolApprovalItem,
  Tool,
} from '@openai/agents';
import type { z } from 'zod';

import { describe, expectTypeOf, it } from 'vitest';

import { createPermDock } from '../../src/openai/index.ts';
import { permissions, policy } from '../fixtures/quick-start.ts';

const { needsApproval, guardTools, resolveInterruptions } = createPermDock(
  policy,
  {
    subject: (context) => context.user,
    tools: { delete_post: { permission: permissions.post.delete } },
  },
);

type Args = z.ZodObject<{ readonly id: z.ZodString }>;

describe('permdock/openai against @openai/agents', () => {
  it('builds a ToolApprovalFunction', () => {
    expectTypeOf(needsApproval(permissions.post.delete)).toExtend<
      FunctionTool<unknown, Args>['needsApproval']
    >();
  });

  it('resolves the interruptions of a RunState', () => {
    // SAFETY: type-level placeholders; toBeCallableWith checks the types and never calls it.
    expectTypeOf(resolveInterruptions).toBeCallableWith(
      {} as RunState<unknown, Agent>,
      [] as RunToolApprovalItem[],
      { context: {} },
    );
  });

  it('filters SDK tools', () => {
    // SAFETY: type-level placeholder; toBeCallableWith checks the type and never calls it.
    expectTypeOf(guardTools<Tool>).toBeCallableWith([] as Tool[], {});
  });
});
