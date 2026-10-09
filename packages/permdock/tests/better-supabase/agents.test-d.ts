import type { AgentToolApprovalFunction } from "better-supabase/ai-sdk/agents";

import { describe, expectTypeOf, it } from "vitest";

import type { AiSdkPermDock } from "../../src/ai-sdk/index.ts";

declare const permdock: AiSdkPermDock;

describe("better-supabase's agent runtime with permdock/ai-sdk", () => {
  it("takes toolApproval and composeToolApproval as its toolApproval", () => {
    expectTypeOf(permdock.toolApproval).toExtend<AgentToolApprovalFunction>();
    expectTypeOf(
      permdock.composeToolApproval(() => "approved"),
    ).toExtend<AgentToolApprovalFunction>();
  });
});
