import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/index.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  approvalsHandler,
  memoryApprovalStore,
  vouchApproval,
} from "../../src/approvals/index.ts";
import { user } from "../../src/core/approvers.ts";

const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    v: 1,
    token: "pd1.vouch",
    permission: "payment.send",
    scope: "payment:send",
    resource: { type: "payment", id: "p1" },
    subject: {
      principal: { id: "u_requester", roles: ["member"], tenant: "o_1" },
      actor: { id: "agent:1", kind: "agent" },
    },
    approvers: {
      by: user("u_cfo"),
      quorum: 2,
    },
    detail: "payment.send requires approval.",
    createdAt: new Date().toISOString(),
    expiresAt: future,
    status: "pending",
    ...overrides,
  };
}

function person(id: string): Subject {
  return { principal: { id, roles: [] }, context: {} };
}

describe("vouchApproval", () => {
  it("resolves with the app's verdict in one step and records the rule", async () => {
    const store = memoryApprovalStore();
    store.create(request());
    const approved = await vouchApproval(store, "pd1.vouch", {
      status: "approved",
      by: person("u_manager"),
      rule: "manager-chain",
      note: "second-level manager",
    });
    expect(approved).toMatchObject({
      status: "approved",
      resolvedBy: "u_manager",
      vouched: "manager-chain",
      note: "second-level manager",
      approvals: [{ by: "u_manager", vouched: "manager-chain" }],
    });
    store.create(request({ token: "pd1.vouch-2" }));
    const rejected = await vouchApproval(store, "pd1.vouch-2", {
      status: "rejected",
      by: person("u_delegate"),
      rule: "delegate",
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      resolvedBy: "u_delegate",
      vouched: "delegate",
    });
  });

  it("still refuses the actor, the requester, a repeated approver and a closed request", async () => {
    const store = memoryApprovalStore();
    store.create(request());
    const vouch = (by: string) =>
      vouchApproval(store, "pd1.vouch", {
        status: "approved",
        by: person(by),
        rule: "manager-chain",
      });
    await expect(vouch("agent:1")).rejects.toMatchObject({
      code: "approver-is-actor",
    });
    await expect(vouch("u_requester")).rejects.toMatchObject({
      code: "approver-is-principal",
    });
    await expect(
      vouchApproval(store, "pd1.vouch", {
        status: "approved",
        by: { principal: null, context: {} },
        rule: "manager-chain",
      }),
    ).rejects.toMatchObject({ code: "approver-unauthenticated" });
    await vouch("u_manager");
    await expect(vouch("u_other")).rejects.toMatchObject({
      code: "approval-not-pending",
    });
    const loose = memoryApprovalStore();
    loose.create(
      request({
        approvers: { by: user("u_cfo"), quorum: 2, distinct: false },
        approvals: [{ by: "u_finance", at: new Date().toISOString() }],
      }),
    );
    await expect(
      vouchApproval(loose, "pd1.vouch", {
        status: "approved",
        by: person("u_finance"),
        rule: "quorum",
      }),
    ).rejects.toMatchObject({ code: "approver-repeated" });
    expect(
      await vouchApproval(loose, "pd1.vouch", {
        status: "approved",
        by: person("u_requester"),
        rule: "self-approval",
      }),
    ).toMatchObject({ status: "approved", resolvedBy: "u_requester" });
  });

  it("needs a rule name, and the HTTP handler never takes one from a body", async () => {
    const store = memoryApprovalStore();
    store.create(request());
    await expect(
      vouchApproval(store, "pd1.vouch", {
        status: "approved",
        by: person("u_manager"),
        rule: "",
      }),
    ).rejects.toThrow(TypeError);
    const handler = approvalsHandler(store, {
      subject: () => ({
        principal: {
          id: "u_outsider",
          roles: [],
          tenant: "o_1",
          memberships: [{ tenant: "o_1", roles: ["member"] }],
        },
        context: {},
      }),
    });
    const response = await handler(
      new Request("https://api.example.com/approvals/pd1.vouch/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vouched: "manager-chain" }),
      }),
    );
    expect(response.status).toBe(403);
    expect((await store.get("pd1.vouch"))?.status).toBe("pending");
  });
});
