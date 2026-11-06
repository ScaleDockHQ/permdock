import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/index.ts";
import type {
  RelationHolder,
  RelationSource,
} from "../../src/core/interfaces.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  approverRelations,
  managerKeys,
} from "../../src/approvals/relations.ts";
import { manager } from "../../src/core/approvers.ts";
import { permissions, relations } from "../fixtures/expenses.ts";

const subject: Subject = {
  principal: {
    id: "mia",
    roles: [],
    memberships: [{ scope: "tenant", id: "o1", roles: ["member"] }],
  },
  context: {},
};

function request(approvers: ApprovalRequest["approvers"]): ApprovalRequest {
  // SAFETY: approverRelations reads the approvers, the resource and the subject.
  return {
    id: "req",
    permission: "expense.pay",
    resource: { type: "expense", id: "e1" },
    subject,
    approvers,
    status: "pending",
  } as unknown as ApprovalRequest;
}

describe("approver relation edges", () => {
  it("waits for a promised ancestor, then holds nothing for a user approver", async () => {
    const slow: RelationSource = {
      ancestors: (query) => Promise.resolve(relations.ancestors(query)),
      related: (query) => relations.related(query),
    };
    const through = await approverRelations(
      request({
        by: {
          kind: "relation",
          resource: "report",
          relation: "approver",
          through: ["report"],
        },
      }),
      subject,
      { relations: slow, permissions },
    );
    expect(Array.isArray(through)).toBe(true);
    expect(
      await approverRelations(
        request({ by: { kind: "user", id: "mia" } }),
        subject,
        { relations, permissions },
      ),
    ).toStrictEqual([]);
  });

  it("skips a manager row with no principal and one that has expired", async () => {
    const source: RelationSource = {
      ancestors: () => ({ ancestors: [] }),
      related: () =>
        // SAFETY: the first row has no principal, so the walk skips it.
        [
          { expiresAt: 1 },
          { principal: { id: "bea" }, expiresAt: 1 },
          { principal: { id: "bea" } },
        ] as RelationHolder[],
    };
    const keys = await managerKeys([manager()], "ada", "bea", {
      relations: source,
    });
    expect(keys).toHaveLength(1);
  });
});
