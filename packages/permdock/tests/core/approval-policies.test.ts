import { describe, expect, it } from "vitest";

import type {
  ApprovalPolicy,
  ApprovalPolicySource,
} from "../../src/core/approval-policies.ts";
import type { Decision } from "../../src/core/decision.ts";
import type { Subject } from "../../src/core/subject.ts";

import { memoryApprovalPolicies } from "../../src/core/approval-policies.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { testApprovalPolicySource } from "../../src/testing/conformance.ts";
import { permissions, policy, rows } from "../fixtures/expenses.ts";

const [large, small] = rows.expense;

function alice(actor?: string): Subject {
  return {
    principal: {
      id: "alice",
      tenant: "o1",
      memberships: [{ scope: "tenant", id: "o1", roles: ["member"] }],
    },
    ...(actor === undefined
      ? {}
      : {
          actor: { id: "bot", kind: actor },
          delegation: { scopes: ["expense:read", "expense:pay"] },
        }),
    context: {},
  };
}

async function decide(
  source: ApprovalPolicySource,
  permission: typeof permissions.expense.read | typeof permissions.expense.pay,
  row: unknown,
  actor?: string,
): Promise<Decision> {
  const permdock = await createPermDock(policy, alice(actor), {
    approvalPolicies: source,
  });
  return permdock.decide(permission, row);
}

const overLimit: ApprovalPolicy = {
  permission: "expense.read",
  tenant: "o1",
  where: { op: "gt", field: "amount", value: 1000 },
  approval: { by: "finance" },
};

describe("ApprovalPolicySource", () => {
  testApprovalPolicySource(
    memoryApprovalPolicies([
      overLimit,
      { permission: "expense.read", tenant: "o2", approval: "human" },
      {
        permission: "expense.pay",
        approval: { by: { kind: "user", id: "cfo" } },
      },
    ]),
    { policy, tenant: "o1" },
  );

  it("turns a grant into approval-required when an entry matches", async () => {
    const source = memoryApprovalPolicies([overLimit]);
    const asked = await decide(source, permissions.expense.read, large);
    expect(asked).toMatchObject({
      outcome: "approval-required",
      grant: {
        approval: {
          mode: "all",
          stages: [{ by: { kind: "role", role: "finance", scope: "global" } }],
        },
      },
    });
    expect(
      (await decide(source, permissions.expense.read, small)).outcome,
    ).toBe("granted");
  });

  it("applies only in its tenant and to its actor kinds", async () => {
    const elsewhere = memoryApprovalPolicies([{ ...overLimit, tenant: "o2" }]);
    expect(
      (await decide(elsewhere, permissions.expense.read, large)).outcome,
    ).toBe("granted");
    const agents = memoryApprovalPolicies([
      { permission: "expense.read", actors: ["agent"], approval: "human" },
    ]);
    expect(
      (await decide(agents, permissions.expense.read, small)).outcome,
    ).toBe("granted");
    expect(
      (await decide(agents, permissions.expense.read, small, "agent")).outcome,
    ).toBe("approval-required");
    expect(
      (await decide(agents, permissions.expense.read, small, "service"))
        .outcome,
    ).toBe("granted");
  });

  it("adds stages after the code's and keeps its order", async () => {
    const source = memoryApprovalPolicies([
      {
        permission: "expense.pay",
        approval: { by: { kind: "user", id: "cfo" }, ttl: "1h" },
      },
    ]);
    const decision = await decide(source, permissions.expense.pay, large);
    expect(decision).toMatchObject({
      outcome: "approval-required",
      grant: {
        approval: {
          mode: "sequential",
          stages: [
            { by: { kind: "relation", relation: "manager" } },
            { by: { kind: "relation", relation: "approver" } },
            { by: { kind: "user", id: "cfo" } },
          ],
          ttl: "1h",
        },
      },
    });
  });

  it("denies every allowed call when the source throws or returns an invalid entry", async () => {
    const throwing: ApprovalPolicySource = {
      approvalPoliciesFor: () => {
        throw new Error("down");
      },
    };
    const rejecting: ApprovalPolicySource = {
      approvalPoliciesFor: async () => {
        throw new Error("down");
      },
    };
    const escalating = memoryApprovalPolicies([
      {
        permission: "expense.read",
        approval: { by: "finance", escalation: { after: "1h", to: "x" } },
      },
    ]);
    const junk: ApprovalPolicySource = {
      approvalPoliciesFor: () =>
        // SAFETY: deliberately malformed input to check the runtime guard.
        [{ permission: "expense.read", approval: 42 }] as never,
    };
    const opaque = memoryApprovalPolicies([
      {
        ...overLimit,
        // SAFETY: deliberately non-portable input to check the runtime guard.
        where: { op: "related", resource: "x" } as never,
      },
    ]);
    for (const source of [throwing, rejecting, escalating, junk, opaque]) {
      expect(await decide(source, permissions.expense.read, small)).toEqual({
        outcome: "denied",
        denials: [
          {
            role: null,
            reason: "approval",
            detail: "approval-policy-unavailable",
          },
        ],
        alternatives: [],
      });
    }
  });

  it("skips an entry for a permission the policy does not declare", async () => {
    const source = memoryApprovalPolicies([
      { permission: "expense.archive", approval: "human" },
    ]);
    expect(
      (await decide(source, permissions.expense.read, small)).outcome,
    ).toBe("granted");
  });

  it("leaves a denial denied", async () => {
    const source = memoryApprovalPolicies([overLimit]);
    const permdock = await createPermDock(
      policy,
      { principal: { id: "eve", memberships: [] }, context: {} },
      { approvalPolicies: source },
    );
    expect(permdock.decide(permissions.expense.read, large)).toMatchObject({
      outcome: "denied",
    });
  });
});
