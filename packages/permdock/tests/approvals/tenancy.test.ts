import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/index.ts";
import type { Membership, Subject } from "../../src/index.ts";

import { assertApprover } from "../../src/approvals/store.ts";
import { membershipTenants } from "../../src/approvals/tenancy.ts";

const request: ApprovalRequest = {
  v: 1,
  id: "apr_1",
  token: "pd1.apr_1",
  permission: "post.delete",
  scope: "post:delete",
  resource: { type: "post", id: "42" },
  subject: { principal: { id: "u_1", roles: [], tenant: "o_1" } },
  detail: "post.delete requires human approval.",
  status: "pending",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
};

function approver(memberships: readonly Membership[]): Subject {
  return { principal: { id: "u_2", roles: [], memberships }, context: {} };
}

describe("approver tenancy", () => {
  it("counts root memberships and principal.tenant, never a nested one", () => {
    expect(
      membershipTenants({
        principal: {
          id: "u_2",
          roles: [],
          tenant: "o_0",
          memberships: [
            { tenant: "o_1", roles: ["admin"] },
            { tenant: "o_2", team: "t_1", roles: ["lead"] },
            { scope: "org", id: "o_3", roles: ["admin"] },
            {
              scope: "team",
              id: "t_2",
              within: { org: "o_4" },
              roles: ["lead"],
            },
          ],
        },
        context: {},
      }),
    ).toEqual(["o_0", "o_1", "o_3"]);
  });

  it("accepts an approver with a membership at the first scope", () => {
    expect(() =>
      assertApprover(
        request,
        approver([{ scope: "org", id: "o_1", roles: ["admin"] }]),
        true,
      ),
    ).not.toThrow();
  });

  it("refuses an approver whose only membership is a team in the tenant", () => {
    const nested: readonly Membership[] = [
      { tenant: "o_1", team: "t_1", roles: ["lead"] },
      { scope: "team", id: "t_1", within: { org: "o_1" }, roles: ["lead"] },
    ];
    for (const membership of nested) {
      expect(() =>
        assertApprover(request, approver([membership]), true),
      ).toThrow("approver does not belong to the request tenant");
    }
  });
});
