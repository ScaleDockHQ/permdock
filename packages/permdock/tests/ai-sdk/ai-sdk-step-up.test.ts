import type { ModelMessage } from "ai";

import { generateText, jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import type { Principal } from "../../src/core/subject.ts";

import { createPermDock } from "../../src/ai-sdk/index.ts";
import { activate } from "../../src/core/elevated.ts";
import { PermDockDeniedError } from "../../src/core/errors.ts";
import { allow, deny } from "../../src/core/grant-builders.ts";
import { assurance } from "../../src/core/grantee.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";

const permissions = definePermissions({
  post: resource({
    id: "id",
    actions: ["read", "delete", "archive", "publish", "export"],
    relations: { org: { field: "orgId", memberOf: "organization" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { organization: { key: "orgId" } },
  roles: [
    role("member", [allow(permissions.post.read)], { on: "organization" }),
    role("editor", [allow(permissions.post.read)], {
      on: "organization",
      activation: { maxDuration: 3600 },
    }),
    role("admin", [allow(permissions.post.archive)], {
      on: "organization",
      activation: { maxDuration: 3600, justification: "required" },
    }),
  ],
  grants: [
    allow(permissions.post.delete, {
      to: assurance({ acr: "mfa", maxAge: 300 }),
    }),
    allow(permissions.post.publish, { to: assurance({ acr: "mfa" }) }),
    deny(permissions.post.publish, { to: { kind: "anyone" } }),
  ],
  subject: (user: Principal | null) => user,
});

const row = (args: unknown) => ({
  // SAFETY: every call in this file passes an object args with a string id.
  id: (args as { readonly id: string }).id,
  orgId: "T",
});

const operations = {
  delete_post: { permission: permissions.post.delete, data: row },
  archive_post: { permission: permissions.post.archive, data: row },
  publish_post: { permission: permissions.post.publish, data: row },
  export_post: { permission: permissions.post.export, data: row },
};

const now = (): number => Math.floor(Date.now() / 1000);

const member: Principal = {
  id: "u1",
  tenant: "T",
  memberships: [
    {
      scope: "organization",
      id: "T",
      roles: ["member"],
      eligible: ["editor", "admin"],
    },
  ],
};

const signedIn: Principal = {
  ...member,
  assurance: { acr: "mfa", authTime: now() },
};

const elevatedAdmin: Principal = {
  ...member,
  memberships: [
    ...(member.memberships ?? []),
    { scope: "organization", id: "T", roles: ["admin"], via: "elevated" },
  ],
};

function adapter(stepUp?: { readonly at?: string }) {
  return createPermDock(policy, {
    // SAFETY: every call in this file passes a runtimeContext object carrying user.
    subject: ({ runtimeContext }) =>
      (runtimeContext as { readonly user: Principal }).user,
    operations,
    ...(stepUp === undefined ? {} : { stepUp }),
  });
}

const call = (toolName: string, user: Principal) => ({
  toolCall: { toolName, toolCallId: "call-1", input: { id: "p1" } },
  runtimeContext: { user },
});

const recheck = (toolName: string, user: Principal) => ({
  ...call(toolName, user),
  messages: [
    {
      role: "assistant",
      content: [
        {
          type: "tool-approval-request",
          approvalId: "a1",
          toolCallId: "call-1",
        },
      ],
    },
  ],
});

describe("permdock/ai-sdk stepUp: authentication", () => {
  it("keeps a step-up denial a denial without the option", async () => {
    const { toolApproval } = adapter();
    expect(await toolApproval(call("delete_post", member))).toMatchObject({
      type: "denied",
    });
  });

  it("asks the user to sign in again, with acr_values and max_age on the URL", async () => {
    const { toolApproval } = adapter({ at: "https://app.example.com/reauth" });
    const status = await toolApproval(call("delete_post", member));
    expect(status).toStrictEqual({
      type: "user-approval",
      reason:
        "Sign in again to use post.delete: https://app.example.com/reauth?acr_values=mfa&max_age=300",
      stepUp: { kind: "authentication", acrValues: ["mfa"], maxAge: 300 },
    });
  });

  it("names no URL without `at` or with one that does not parse", async () => {
    for (const stepUp of [{}, { at: "not a url" }]) {
      const { toolApproval } = adapter(stepUp);
      expect(await toolApproval(call("delete_post", member))).toMatchObject({
        type: "user-approval",
        reason: "Sign in again to use post.delete.",
      });
    }
  });

  it("re-decides on the re-check: approved after the sign-in, denied without it", async () => {
    const { toolApproval } = adapter({});
    expect(await toolApproval(recheck("delete_post", signedIn))).toBe(
      "approved",
    );
    expect(await toolApproval(recheck("delete_post", member))).toMatchObject({
      type: "denied",
    });
  });

  it("never steps up past a matching deny", async () => {
    const { toolApproval } = adapter({});
    expect(await toolApproval(call("publish_post", member))).toMatchObject({
      type: "denied",
    });
  });

  it("never steps up past an agent's delegation", async () => {
    const { toolApproval } = createPermDock(policy, {
      // SAFETY: every call in this file passes a runtimeContext object carrying user.
      subject: ({ runtimeContext }) =>
        (runtimeContext as { readonly user: Principal }).user,
      actor: () => ({ id: "agent-1", kind: "ai-sdk" }),
      delegation: () => ({ scopes: [permissions.post.read.scope] }),
      operations,
      stepUp: {},
    });
    for (const toolName of ["delete_post", "archive_post"]) {
      expect(await toolApproval(call(toolName, member))).toMatchObject({
        type: "denied",
      });
    }
  });

  it("never steps up an unmapped tool", async () => {
    const { toolApproval } = adapter({});
    expect(await toolApproval(call("explode", member))).toStrictEqual({
      type: "denied",
      reason: "Denied: unmapped tool explode.",
    });
  });
});

describe("permdock/ai-sdk stepUp: activation", () => {
  it("names the eligible role whose activation grants the call", async () => {
    const { toolApproval } = adapter({});
    expect(await toolApproval(call("archive_post", member))).toStrictEqual({
      type: "user-approval",
      reason: "Activate the admin role on organization T to use post.archive.",
      stepUp: {
        kind: "activation",
        role: "admin",
        scope: "organization",
        id: "T",
      },
    });
  });

  it("names a role `activate` accepts for the subject", async () => {
    const { toolApproval } = adapter({});
    const status = await toolApproval(call("archive_post", member));
    if (typeof status !== "object" || !("stepUp" in status)) {
      throw new Error("expected a step-up");
    }
    if (status.stepUp.kind !== "activation") {
      throw new Error("expected an activation");
    }
    const decision = activate(getPermDockSync(policy, member), {
      role: status.stepUp.role,
      scope: status.stepUp.scope,
      id: status.stepUp.id,
      reason: "archive p1",
    });
    expect(decision.outcome).toBe("granted");
  });

  it("re-decides on the re-check: approved once the elevated membership is held", async () => {
    const { toolApproval } = adapter({});
    expect(await toolApproval(recheck("archive_post", elevatedAdmin))).toBe(
      "approved",
    );
    expect(await toolApproval(recheck("archive_post", member))).toMatchObject({
      type: "denied",
    });
  });

  it("stays denied when no eligible role grants the call", async () => {
    const { toolApproval } = adapter({});
    expect(await toolApproval(call("export_post", member))).toMatchObject({
      type: "denied",
    });
  });

  it("stays denied for an expired eligible membership", async () => {
    const { toolApproval } = adapter({});
    const expired: Principal = {
      id: "u1",
      tenant: "T",
      memberships: [
        {
          scope: "organization",
          id: "T",
          roles: ["member"],
          eligible: ["admin"],
          expiresAt: now() - 60,
        },
      ],
    };
    expect(await toolApproval(call("archive_post", expired))).toMatchObject({
      type: "denied",
    });
  });
});

describe("permdock/ai-sdk stepUp: needsApproval and the middleware", () => {
  it("suspends for a step-up and throws on a re-check that is still denied", async () => {
    const { needsApproval } = adapter({});
    const predicate = needsApproval(permissions.post.delete);
    const asked = (user: Principal) => ({
      toolCallId: "call-1",
      context: { runtimeContext: { user } },
      messages: recheck("delete_post", user).messages,
    });
    expect(
      await predicate(
        { id: "p1" },
        { context: { runtimeContext: { user: member } } },
      ),
    ).toBe(true);
    await expect(predicate({ id: "p1" }, asked(member))).rejects.toThrow(
      PermDockDeniedError,
    );
    expect(await predicate({ id: "p1" }, asked(signedIn))).toBe(false);
  });

  it("offers the model a tool an eligible activation opens only with stepUp", async () => {
    const params = {
      tools: [{ name: "archive_post" }, { name: "export_post" }],
    };
    const context = { runtimeContext: { user: member } };
    const without = await adapter()
      .capabilityMiddleware(context)
      .transformParams({ params });
    expect(without.tools?.map((next) => next.name)).toStrictEqual([]);
    const withStepUp = await adapter({})
      .capabilityMiddleware(context)
      .transformParams({ params });
    expect(withStepUp.tools?.map((next) => next.name)).toStrictEqual([
      "archive_post",
    ]);
  });
});

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function callsDelete(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "delete_post",
            input: JSON.stringify({ id: "p1" }),
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

function approvalOf(messages: readonly ModelMessage[]): {
  readonly approvalId: string;
} {
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
  throw new Error("no tool-approval-request");
}

describe("permdock/ai-sdk stepUp inside generateText", () => {
  it("pauses the loop for a sign-in and runs the call once the subject has stepped up", async () => {
    const { toolApproval } = adapter({ at: "https://app.example.com/reauth" });
    const execute = vi.fn<() => string>(() => "deleted");
    const tools = {
      delete_post: tool({
        inputSchema: jsonSchema<{ readonly id: string }>({
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        }),
        execute,
      }),
    };
    const first = await generateText({
      model: callsDelete(),
      prompt: "delete p1",
      tools,
      toolApproval,
      runtimeContext: { user: member },
    });
    expect(execute).not.toHaveBeenCalled();
    const messages = first.finalStep.response.messages;
    const resumed = (user: Principal) =>
      generateText({
        model: replies(),
        messages: [
          { role: "user", content: "delete p1" },
          ...messages,
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: approvalOf(messages).approvalId,
                approved: true,
              },
            ],
          },
        ],
        tools,
        toolApproval,
        runtimeContext: { user },
      });

    await resumed(member);
    expect(execute).not.toHaveBeenCalled();
    await resumed(signedIn);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("permdock/ai-sdk stepUp with a wrapped instance", () => {
  it("still finds the activation", async () => {
    const { toolApproval } = createPermDock(policy, {
      // SAFETY: every call in this file passes a runtimeContext object carrying user.
      subject: ({ runtimeContext }) =>
        (runtimeContext as { readonly user: Principal }).user,
      operations,
      stepUp: {},
      wrap: (permdock) => permdock,
    });
    expect(await toolApproval(call("archive_post", member))).toMatchObject({
      type: "user-approval",
      stepUp: { kind: "activation", role: "admin" },
    });
  });
});
