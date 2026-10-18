import { describe, expect, it } from "vitest";

import type { Subject } from "../../src/core/subject.ts";

import {
  memoryApprovalPolicySource,
  validateApprovalPolicy,
} from "../../src/core/approval-policies.ts";
import { defineOperations } from "../../src/core/operations.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { permissions, policy, rows } from "../fixtures/expenses.ts";

const [, small] = rows.expense;

const alice: Subject = {
  principal: {
    id: "alice",
    tenant: "o1",
    memberships: [{ scope: "tenant", id: "o1", roles: ["member"] }],
  },
  context: {},
};

const operations = defineOperations(permissions, {
  pay_expense: {
    permission: permissions.expense.pay,
    meta: { risk: "high", effects: ["spend"] },
  },
  read_expense: {
    permission: permissions.expense.read,
    meta: { risk: "low", effects: ["read"] },
  },
  export_expense: {
    permission: permissions.expense.read,
    meta: { risk: "medium", effects: ["read", "external"] },
  },
});

async function instance(
  entries: Parameters<typeof memoryApprovalPolicySource>[0],
) {
  return getPermDockSync(policy, alice, {
    approvalPolicies: memoryApprovalPolicySource(entries),
  });
}

describe("ApprovalPolicySource meta matching", () => {
  it("adds a stage for an operation whose risk is listed", async () => {
    const permdock = await instance([
      { risk: ["high", "critical"], approval: { by: "finance" } },
    ]);
    expect(
      permdock.decide(permissions.expense.read, small, {
        operation: operations.read_expense,
      }).outcome,
    ).toBe("granted");
    const asked = permdock.decide(permissions.expense.read, small, {
      operation: { name: "read_as_high", meta: { risk: "high" } },
    });
    expect(asked.outcome).toBe("approval-required");
  });

  it("matches any listed effect", async () => {
    const permdock = await instance([
      { effects: ["external", "send"], approval: "human" },
    ]);
    expect(
      permdock.decide(permissions.expense.read, small, {
        operation: operations.export_expense,
      }).outcome,
    ).toBe("approval-required");
    expect(
      permdock.decide(permissions.expense.read, small, {
        operation: operations.read_expense,
      }).outcome,
    ).toBe("granted");
  });

  it("needs both risk and effects when an entry sets both, and its permission", async () => {
    const permdock = await instance([
      {
        permission: "expense.read",
        risk: ["medium"],
        effects: ["external"],
        approval: "human",
      },
    ]);
    expect(
      permdock.decide(permissions.expense.read, small, {
        operation: operations.export_expense,
      }).outcome,
    ).toBe("approval-required");
    expect(
      permdock.decide(permissions.expense.read, small, {
        operation: { name: "x", meta: { risk: "medium", effects: ["read"] } },
      }).outcome,
    ).toBe("granted");
  });

  it("never matches a call that names no operation", async () => {
    const permdock = await instance([{ risk: ["low"], approval: "human" }]);
    expect(permdock.decide(permissions.expense.read, small).outcome).toBe(
      "granted",
    );
  });

  it("only adds stages: a meta entry never removes the code's approval", async () => {
    const permdock = await instance([{ risk: ["high"], approval: "human" }]);
    const code = permdock.decide(permissions.expense.read, rows.expense[0], {
      operation: operations.read_expense,
    });
    const plain = permdock.decide(permissions.expense.read, rows.expense[0]);
    expect(code.outcome).toBe(plain.outcome);
  });

  it("validates meta entries", () => {
    expect(
      validateApprovalPolicy(policy, { risk: ["high"], approval: "human" }),
    ).toEqual({ ok: true });
    expect(validateApprovalPolicy(policy, { approval: "human" })).toEqual({
      ok: false,
      problem: "invalid",
    });
    expect(
      validateApprovalPolicy(policy, { risk: ["extreme"], approval: "human" }),
    ).toEqual({ ok: false, problem: "invalid" });
    expect(
      validateApprovalPolicy(policy, { effects: [], approval: "human" }),
    ).toEqual({ ok: false, problem: "invalid" });
    expect(
      validateApprovalPolicy(policy, {
        effects: ["send"],
        where: { op: "eq", field: "amount", value: 1 },
        approval: "human",
      }),
    ).toEqual({ ok: false, problem: "invalid" });
  });

  it("fails closed on an invalid meta entry", async () => {
    const permdock = await instance([
      // SAFETY: a deliberately invalid entry, as a data store might return.
      { risk: "high", approval: "human" } as never,
    ]);
    expect(permdock.decide(permissions.expense.read, small).outcome).toBe(
      "denied",
    );
  });
});
