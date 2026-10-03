import type {
  LanguageModelMiddleware,
  Tool,
  ToolApprovalConfiguration,
} from "ai";

import { tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { createPermDock } from "../../src/ai-sdk/index.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

const { toolApproval, needsApproval, capabilityMiddleware } = createPermDock(
  policy,
  {
    subject: () => memberUser,
    tools: { delete_post: { permission: permissions.post.delete } },
  },
);

const tools = {
  delete_post: tool({
    inputSchema: z.object({ id: z.string() }),
    execute: () => "deleted",
  }),
};

describe("permdock/ai-sdk against ai", () => {
  it("provides a ToolApprovalConfiguration", () => {
    expectTypeOf(toolApproval).toExtend<
      ToolApprovalConfiguration<typeof tools, unknown>
    >();
  });

  it("provides a tool-level needsApproval", () => {
    expectTypeOf(needsApproval(permissions.post.delete)).toExtend<
      NonNullable<Tool<{ readonly id: string }, string>["needsApproval"]>
    >();
  });

  it("builds a LanguageModelMiddleware per context", () => {
    expectTypeOf(
      capabilityMiddleware({ user: memberUser }),
    ).toExtend<LanguageModelMiddleware>();
    expectTypeOf(wrapLanguageModel).toBeCallableWith({
      model: new MockLanguageModelV4(),
      middleware: capabilityMiddleware({}),
    });
  });
});
