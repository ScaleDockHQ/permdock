import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/index.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  memoryApprovalStore,
  resolveApproval,
} from "../../src/approvals/index.ts";
import { readWireApproval } from "../../src/core/approval-normalize.ts";

const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function pending(
  token: string,
  approvers: NonNullable<ApprovalRequest["approvers"]>,
): ApprovalRequest {
  return {
    v: 1,
    id: token,
    token,
    permission: "post.delete",
    scope: "post:delete",
    resource: { type: "post", id: "42" },
    subject: { principal: { id: "u_1", roles: ["member"] } },
    approvers,
    detail: "post.delete requires approval.",
    createdAt: new Date().toISOString(),
    expiresAt: future,
    status: "pending",
  };
}

const confirm: NonNullable<ApprovalRequest["approvers"]> = {
  by: { kind: "authenticated" },
  mode: "confirm",
};

const self: Subject = {
  principal: { id: "u_1", roles: ["member"] },
  context: {},
};

const colleague: Subject = {
  principal: { id: "u_2", roles: ["member"] },
  context: {},
};

describe("approval mode", () => {
  it("lets the principal confirm their own request", async () => {
    const store = memoryApprovalStore();
    await store.create(pending("pd1.confirm", confirm));
    await expect(
      resolveApproval(store, "pd1.confirm", { status: "approved", by: self }),
    ).resolves.toMatchObject({ status: "approved", resolvedBy: "u_1" });
  });

  it.each<[string, Subject]>([
    [
      "an agent acting for another member",
      { ...colleague, actor: { id: "agent_1", kind: "ai-sdk" } },
    ],
    [
      "a delegated token",
      { ...colleague, delegation: { scopes: ["posts:write"] } },
    ],
    [
      "a service principal",
      {
        principal: { id: "svc_1", roles: ["member"], kind: "service" },
        context: {},
      },
    ],
  ])("never accepts %s, under confirm or authorize", async (_label, by) => {
    for (const [token, approvers] of [
      ["pd1.confirm-agent", confirm],
      ["pd1.authorize-agent", { by: { kind: "authenticated" } }],
    ] as const) {
      const store = memoryApprovalStore();
      await store.create(pending(token, approvers));
      await expect(
        resolveApproval(store, token, { status: "approved", by }),
      ).rejects.toMatchObject({ code: "approver-not-eligible" });
      expect((await store.get(token))?.status).toBe("pending");
    }
  });
});

describe("approval mode with the principal's own agent", () => {
  it("refuses the principal confirming through an agent", async () => {
    const store = memoryApprovalStore();
    await store.create(pending("pd1.self-agent", confirm));
    await expect(
      resolveApproval(store, "pd1.self-agent", {
        status: "approved",
        by: { ...self, actor: { id: "agent_1", kind: "ai-sdk" } },
      }),
    ).rejects.toMatchObject({ code: "approver-not-eligible" });
  });
});

describe(readWireApproval, () => {
  it("reads a v1 record written before 0.17 under the current names", () => {
    expect(
      readWireApproval({
        stages: [{ by: { kind: "authenticated" } }],
        combine: "sequential",
        mode: "confirm",
      }),
    ).toStrictEqual({
      stages: [{ by: { kind: "authenticated" } }],
      combine: "sequential",
      mode: "confirm",
    });
    expect(readWireApproval({ by: "x" })).toStrictEqual({ by: "x" });
    const current = { combine: "all", mode: "confirm" } as const;
    expect(readWireApproval(current)).toBe(current);
    expect(readWireApproval("human")).toBe("human");
  });

  it("lets a legacy sequential request admit only the first open stage", async () => {
    const store = memoryApprovalStore();
    // SAFETY: a stored v1 record from before 0.17, which the type no longer describes.
    const legacy = {
      stages: [
        { by: { kind: "user", id: "u_a" } },
        { by: { kind: "user", id: "u_b" } },
      ],
      combine: "sequential",
    } as unknown as NonNullable<ApprovalRequest["approvers"]>;
    await store.create(pending("pd1.legacy", legacy));
    await expect(
      resolveApproval(store, "pd1.legacy", {
        status: "approved",
        by: { principal: { id: "u_b", roles: [] }, context: {} },
      }),
    ).rejects.toMatchObject({ code: "approver-not-eligible" });
  });
});
