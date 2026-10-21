import { describe, expect, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";
import type { PolicyVocabulary } from "../../src/core/policy-types.ts";
import type { OpenAiInterruption } from "../../src/openai/index.ts";

import { createPermDock as aiSdk } from "../../src/ai-sdk/index.ts";
import { createPermDock as claudeAgent } from "../../src/claude-agent/index.ts";
import { defineOperations } from "../../src/core/operations.ts";
import { createPermDock as eve } from "../../src/eve/index.ts";
import { createPermDock as openai } from "../../src/openai/index.ts";
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const operations = defineOperations(permissions, {
  publish_post: {
    permission: permissions.post.publish,
    data: (input: { readonly id: string }) =>
      input.id === ownPost.id ? ownPost : null,
    meta: { risk: "high", effects: ["write"] },
  },
  list_posts: { permission: permissions.post.list },
});

function tracing(calls: string[]): {
  readonly otel: <V extends PolicyVocabulary>(
    permdock: PermDock<V>,
  ) => PermDock<V>;
  readonly wrap: <V extends PolicyVocabulary>(
    permdock: PermDock<V>,
  ) => PermDock<V>;
} {
  return {
    otel: (permdock) => {
      calls.push("otel");
      return permdock;
    },
    wrap: (permdock) => {
      calls.push("wrap");
      return permdock;
    },
  };
}

const deniedText = ({ text }: { readonly text: string }): string =>
  `Refused. ${text}`;

describe("agent adapter options", () => {
  it("permdock/ai-sdk decides from an OperationMap with otel, wrap and deniedText", async () => {
    const calls: string[] = [];
    const { toolApproval } = aiSdk(policy, {
      subject: () => memberUser,
      operations,
      deniedText,
      ...tracing(calls),
    });
    const verdict = await toolApproval({
      toolCall: { toolName: "publish_post", input: { id: ownPost.id } },
    });
    expect(verdict).toMatchObject({
      type: "denied",
      reason: expect.stringMatching(/^Refused\. /u),
    });
    expect(calls).toEqual(["otel", "wrap"]);
  });

  it("permdock/openai keeps unmapped tools under unmapped: 'allow' and leaves their interruptions", async () => {
    const calls: string[] = [];
    const { guardTools, resolveInterruptions, getPermDock } = openai(policy, {
      subject: () => memberUser,
      operations,
      unmapped: "allow",
      context: () => ({ channel: "chat" }),
      deniedText,
      ...tracing(calls),
    });
    const kept = await guardTools(
      [{ name: "list_posts" }, { name: "publish_post" }, { name: "weather" }],
      {},
    );
    expect(kept.map((tool) => tool.name)).toEqual(["list_posts", "weather"]);
    const outcomes: string[] = [];
    // SAFETY: the two fields resolveInterruptions reads.
    const items = [
      { name: "weather", arguments: "{}" },
      { name: "publish_post", arguments: `{"id":"${ownPost.id}"}` },
    ] as unknown as OpenAiInterruption[];
    await resolveInterruptions(
      {
        approve: (item) => outcomes.push(`approve:${String(item.name)}`),
        reject: (item, rejectOptions) =>
          outcomes.push(
            `reject:${String(item.name)}:${rejectOptions?.message?.slice(0, 8) ?? ""}`,
          ),
      },
      items,
      { context: {} },
    );
    expect(outcomes).toEqual(["reject:publish_post:Refused."]);
    const permdock = await getPermDock({ user: "x" });
    expect(permdock.subject.context).toMatchObject({ channel: "chat" });
    expect(calls.slice(0, 2)).toEqual(["otel", "wrap"]);
  });

  it("permdock/openai denies unmapped tools by default", async () => {
    const { guardTools } = openai(policy, {
      subject: () => memberUser,
      operations,
    });
    const kept = await guardTools([{ name: "weather" }], {});
    expect(kept).toEqual([]);
  });

  it("permdock/claude-agent allows an unmapped tool from canUseTool and leaves the hook undecided", async () => {
    const { canUseTool, permissionRequestHook } = claudeAgent(policy, {
      subject: () => memberUser,
      operations,
      unmapped: "allow",
      deniedText,
    });
    expect(await canUseTool("Read", { file: "a" })).toEqual({
      behavior: "allow",
      updatedInput: { file: "a" },
    });
    expect(
      await permissionRequestHook({
        hook_event_name: "PermissionRequest",
        tool_name: "Read",
        tool_input: {},
      }),
    ).toEqual({});
    expect(await canUseTool("publish_post", { id: ownPost.id })).toMatchObject({
      behavior: "deny",
      message: expect.stringMatching(/^Refused\. /u),
    });
    expect(
      await canUseTool(
        "mcp__other__tool",
        {},
        { mcpServer: { name: "other", source: "remote" } },
      ),
    ).toMatchObject({ behavior: "deny" });
  });

  it("permdock/eve answers not-applicable for an unmapped tool under unmapped: 'allow'", async () => {
    const calls: string[] = [];
    const { approval } = eve(policy, {
      subject: () => memberUser,
      operations,
      unmapped: "allow",
      deniedText,
      ...tracing(calls),
    });
    expect(await approval.request({ toolName: "weather" })).toBe(
      "not-applicable",
    );
    expect(
      await approval.request({
        toolName: "publish_post",
        toolInput: { id: ownPost.id },
      }),
    ).toEqual({
      type: "denied",
      reason: expect.stringMatching(/^Refused\. /u),
    });
    expect(calls).toEqual(["otel", "wrap"]);
  });

  it("permdock/eve denies an unmapped tool by default", async () => {
    const { approval } = eve(policy, { subject: () => memberUser, operations });
    expect(await approval.request({ toolName: "weather" })).toMatchObject({
      type: "denied",
    });
  });
});
