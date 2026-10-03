import type { ModelMessage } from "ai";

import { generateText, jsonSchema, tool, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { createPermDock } from "../../src/ai-sdk/index.ts";
import { memoryApprovalStore } from "../../src/approvals/index.ts";
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
} from "../../src/core/errors.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function callsTool(toolName: string, input: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName,
            input: JSON.stringify(input),
          },
        ],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });
}

function replies(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: "done" }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    },
  });
}

const input = jsonSchema<{ readonly id: string }>({
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
});

function bindings() {
  return {
    delete_post: {
      permission: permissions.post.delete,
      // SAFETY: every tool call in this file passes an object args with an optional id.
      data: (args: unknown) =>
        (args as { readonly id?: string }).id === "p1" ? ownPost : otherPost,
    },
    publish_post: {
      permission: permissions.post.publish,
      // SAFETY: every tool call in this file passes an object args with an optional id.
      data: (args: unknown) =>
        (args as { readonly id?: string }).id === "p1" ? ownPost : otherPost,
    },
  };
}

function approvalRequestOf(
  messages: readonly ModelMessage[],
): { readonly approvalId: string } | undefined {
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-approval-request") {
        return { approvalId: part.approvalId };
      }
    }
  }
  return undefined;
}

function approve(
  messages: readonly ModelMessage[],
  approvalId: string,
): ModelMessage[] {
  return [
    { role: "user", content: "delete p1" },
    ...messages,
    {
      role: "tool",
      content: [{ type: "tool-approval-response", approvalId, approved: true }],
    },
  ];
}

describe("permdock/ai-sdk inside generateText", () => {
  it("fails the call instead of offering approval for a denied tool", async () => {
    const { needsApproval } = createPermDock(policy, {
      subject: () => memberUser,
      tools: bindings(),
    });
    const execute = vi.fn<() => string>(() => "published");
    await expect(
      generateText({
        model: callsTool("publish_post", { id: "p1" }),
        prompt: "publish p1",
        tools: {
          publish_post: tool({
            inputSchema: input,
            execute,
            // oxlint-disable-next-line typescript/no-deprecated
            needsApproval: needsApproval(permissions.post.publish),
          }),
        },
      }),
    ).rejects.toThrow(PermDockDeniedError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("never runs an approved call the store has not approved (toolApproval)", async () => {
    const store = memoryApprovalStore();
    const { toolApproval } = createPermDock(policy, {
      subject: () => memberUser,
      tools: bindings(),
      store,
    });
    const execute = vi.fn<() => string>(() => "deleted");
    const tools = {
      delete_post: tool({ inputSchema: input, execute }),
    };
    const first = await generateText({
      model: callsTool("delete_post", { id: "p1" }),
      prompt: "delete p1",
      tools,
      toolApproval,
    });
    const request = approvalRequestOf(first.finalStep.response.messages);
    expect(request).toBeDefined();
    expect(execute).not.toHaveBeenCalled();

    await generateText({
      model: replies(),
      messages: approve(first.finalStep.response.messages, request!.approvalId),
      tools,
      toolApproval,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("never runs an approved call the store has not approved (needsApproval)", async () => {
    const store = memoryApprovalStore();
    const { needsApproval } = createPermDock(policy, {
      subject: () => memberUser,
      tools: bindings(),
      store,
    });
    const execute = vi.fn<() => string>(() => "deleted");
    const tools = {
      delete_post: tool({
        inputSchema: input,
        execute,
        // oxlint-disable-next-line typescript/no-deprecated
        needsApproval: needsApproval(permissions.post.delete),
      }),
    };
    const first = await generateText({
      model: callsTool("delete_post", { id: "p1" }),
      prompt: "delete p1",
      tools,
    });
    const request = approvalRequestOf(first.finalStep.response.messages);
    expect(request).toBeDefined();
    await expect(
      generateText({
        model: replies(),
        messages: approve(
          first.finalStep.response.messages,
          request!.approvalId,
        ),
        tools,
      }),
    ).rejects.toThrow(PermDockApprovalRequiredError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs a re-checked call once the store holds the approval", async () => {
    const store = memoryApprovalStore();
    const { toolApproval } = createPermDock(policy, {
      subject: () => memberUser,
      tools: bindings(),
      store,
    });
    const execute = vi.fn<() => string>(() => "deleted");
    const tools = { delete_post: tool({ inputSchema: input, execute }) };
    const first = await generateText({
      model: callsTool("delete_post", { id: "p1" }),
      prompt: "delete p1",
      tools,
      toolApproval,
    });
    const [pending] = (await store.list({ status: "pending" })).items;
    expect(pending).toBeDefined();
    await store.resolve(pending!.token, {
      status: "approved",
      by: { principal: { id: "u2", roles: ["admin"] }, context: {} },
    });
    await generateText({
      model: replies(),
      messages: approve(
        first.finalStep.response.messages,
        approvalRequestOf(first.finalStep.response.messages)!.approvalId,
      ),
      tools,
      toolApproval,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("hides tools from the model through wrapLanguageModel", async () => {
    const { capabilityMiddleware } = createPermDock(policy, {
      subject: (context) => context["user"],
      tools: bindings(),
    });
    const model = replies();
    await generateText({
      model: wrapLanguageModel({
        model,
        middleware: capabilityMiddleware({ user: memberUser }),
      }),
      prompt: "hi",
      tools: {
        delete_post: tool({ inputSchema: input, execute: () => "deleted" }),
        publish_post: tool({ inputSchema: input, execute: () => "published" }),
      },
    });
    expect(model.doGenerateCalls[0]?.tools?.map((next) => next.name)).toEqual([
      "delete_post",
    ]);
  });
});
