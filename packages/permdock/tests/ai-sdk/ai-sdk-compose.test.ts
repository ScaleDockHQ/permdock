import { describe, expect, it } from "vitest";

import type {
  AppToolApproval,
  ToolApprovalCall,
} from "../../src/ai-sdk/index.ts";

import { createPermDock } from "../../src/ai-sdk/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const call = (toolName: string): ToolApprovalCall => ({
  toolCall: { toolName, toolCallId: "c1", input: {} },
});

function permdock(unmapped?: "deny" | "allow") {
  return createPermDock(policy, {
    subject: () => memberUser,
    tools: {
      read_post: { permission: permissions.post.read, data: () => ownPost },
      publish_post: {
        permission: permissions.post.publish,
        data: () => otherPost,
      },
    },
    ...(unmapped === undefined ? {} : { unmapped }),
  });
}

function registry(asked: string[]): AppToolApproval {
  return (approval) => {
    asked.push(approval.toolCall.toolName);
    return approval.toolCall.toolName === "send_email"
      ? "user-approval"
      : undefined;
  };
}

describe("permdock/ai-sdk composition", () => {
  it("hides and denies a tool without a permission by default", async () => {
    const asked: string[] = [];
    const { capabilityMiddleware, composeToolApproval } = permdock();
    const params = await capabilityMiddleware({}).transformParams({
      params: {
        tools: [
          { name: "read_post" },
          { name: "publish_post" },
          { name: "weather" },
        ],
        toolChoice: { type: "tool", toolName: "weather" },
      },
    });
    expect(params.tools).toEqual([{ name: "read_post" }]);
    expect(params.toolChoice).toEqual({ type: "none" });
    expect(
      await composeToolApproval(registry(asked))(call("weather")),
    ).toMatchObject({
      type: "denied",
    });
    expect(asked).toEqual([]);
  });

  it("passes unmapped tools through with unmapped 'allow'", async () => {
    const asked: string[] = [];
    const { capabilityMiddleware, toolApproval, composeToolApproval } =
      permdock("allow");
    const params = await capabilityMiddleware({}).transformParams({
      params: {
        tools: [{ name: "publish_post" }, { name: "weather" }],
        toolChoice: { type: "tool", toolName: "weather" },
      },
    });
    expect(params.tools).toEqual([{ name: "weather" }]);
    expect(params.toolChoice).toEqual({ type: "tool", toolName: "weather" });
    expect(await toolApproval(call("weather"))).toBe("approved");
    const approve = composeToolApproval(registry(asked));
    expect(await approve(call("weather"))).toBe("approved");
    expect(await approve(call("send_email"))).toBe("user-approval");
    expect(asked).toEqual(["weather", "send_email"]);
  });

  it("asks the application only after PermDock grants, and never past a denial", async () => {
    const asked: string[] = [];
    const approve = permdock("allow").composeToolApproval(registry(asked));
    expect(await approve(call("read_post"))).toBe("approved");
    expect(await approve(call("publish_post"))).toMatchObject({
      type: "denied",
    });
    expect(asked).toEqual(["read_post"]);
  });
});
