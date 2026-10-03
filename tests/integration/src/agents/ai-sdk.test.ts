import type { ModelMessage } from "ai";

import {
  jsonSchema,
  simulateReadableStream,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createPermDock } from "permdock/ai-sdk";
import { resolveApproval } from "permdock/approvals";
import { saasPolicy, saasPrincipal } from "permdock/testing/saas";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AgentDb } from "../support/agents.ts";

import {
  agentDelegation,
  agentSubject,
  agentTools,
  owner,
  projectLoader,
  startAgentDb,
  TENANT,
} from "../support/agents.ts";

type LanguageModelV4StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4["doStream"]>
  >["stream"] extends ReadableStream<infer T>
    ? T
    : never;

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function toolCalls(
  calls: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[],
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    ...calls.map((call): LanguageModelV4StreamPart => ({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: JSON.stringify(call.input),
    })),
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: undefined },
      usage,
    },
  ];
}

const reply: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "done" },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
];

function scripted(steps: readonly LanguageModelV4StreamPart[][]) {
  return new MockLanguageModelV4({
    doStream: steps.map((chunks) => ({
      stream: simulateReadableStream({ chunks }),
    })),
  });
}

const byId = jsonSchema<{ readonly id: string }>({
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
});
const none = jsonSchema<Record<string, never>>({
  type: "object",
  properties: {},
});

function approvalIdOf(messages: readonly ModelMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-approval-request") {
        return part.approvalId;
      }
    }
  }
  return undefined;
}

let db: AgentDb;
let rows: ReturnType<typeof projectLoader>;

beforeAll(async () => {
  db = await startAgentDb();
  rows = projectLoader(db.pg.uri);
});

afterAll(async () => {
  await rows.close();
  await db.stop();
});

async function agent() {
  return createPermDock(saasPolicy, {
    subject: (context) => agentSubject({ user: context["user"] }),
    actor: () => ({ id: "support-bot", kind: "ai-sdk" }),
    tenant: TENANT,
    delegation: agentDelegation,
    tools: agentTools(rows.load),
    store: await db.openStore(),
  });
}

describe("permdock/ai-sdk in a multi-step streamText loop on Postgres", () => {
  it("runs granted steps, skips denied ones, and resumes an owner-approved call once on a fresh instance", async () => {
    const deleted = vi.fn<(input: { readonly id: string }) => string>(
      ({ id }) => `deleted ${id}`,
    );
    const revoked = vi.fn<() => string>(() => "revoked");
    const tools = {
      delete_project: tool({ inputSchema: byId, execute: deleted }),
      revoke_api_keys: tool({ inputSchema: none, execute: revoked }),
    };
    const runtimeContext = { user: "alice" };

    const first = streamText({
      model: scripted([
        toolCalls([
          { id: "c1", name: "delete_project", input: { id: "p1" } },
          { id: "c2", name: "delete_project", input: { id: "p4" } },
        ]),
        toolCalls([{ id: "c3", name: "revoke_api_keys", input: {} }]),
        reply,
      ]),
      prompt: "clean up acme",
      tools,
      toolApproval: (await agent()).toolApproval,
      runtimeContext,
      stopWhen: stepCountIs(5),
    });
    await first.consumeStream();
    const { messages } = (await first.finalStep).response;
    expect(deleted.mock.calls.map(([input]) => input.id)).toEqual(["p1"]);
    expect(revoked).not.toHaveBeenCalled();
    const approvalId = approvalIdOf(messages);
    expect(approvalId).toBeDefined();

    const reviewer = await db.openStore();
    const [pending] = (await reviewer.list({ status: "pending" })).items;
    expect(pending?.permission).toBe("apiKey.revokeAll");
    await expect(
      resolveApproval(reviewer, pending!.token, {
        status: "approved",
        by: { principal: saasPrincipal("alice", TENANT), context: {} },
      }),
    ).rejects.toThrow("approver");
    await resolveApproval(reviewer, pending!.token, {
      status: "approved",
      by: owner,
    });

    const resumed: ModelMessage[] = [
      { role: "user", content: "clean up acme" },
      ...messages,
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: approvalId!,
            approved: true,
          },
        ],
      },
    ];
    const second = streamText({
      model: scripted([reply]),
      messages: resumed,
      tools,
      toolApproval: (await agent()).toolApproval,
      runtimeContext,
    });
    await second.consumeStream();
    expect(revoked).toHaveBeenCalledTimes(1);

    const replay = streamText({
      model: scripted([reply]),
      messages: resumed,
      tools,
      toolApproval: (await agent()).toolApproval,
      runtimeContext,
    });
    await replay.consumeStream();
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(deleted).toHaveBeenCalledTimes(1);
  });
});
