import { describe, expect, it } from "vitest";

import { memoryApprovalPolicies } from "../../src/core/approval-policies.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { createPermDock } from "../../src/pdp/index.ts";

const permissions = definePermissions({
  post: resource({ id: "id", actions: ["read"] }),
});

const policy = definePolicy(permissions, {
  roles: [role("member", [allow(permissions.post.read)])],
  subject: (user: { readonly id: string; readonly roles: readonly string[] }) =>
    user,
  providers: [],
});

describe("permdock/pdp derive", () => {
  it("keeps the PDP wrapper on a derived instance, sync and async", async () => {
    const permdock = await createPermDock(policy, {
      id: "u1",
      roles: ["member"],
    });
    const same = permdock.derive({});
    if (same instanceof Promise) {
      throw new TypeError("expected a synchronous instance");
    }
    expect(await same.can(permissions.post.read, { id: "p" })).toBe(true);
    const gated = await permdock.derive({
      approvalPolicies: {
        approvalPoliciesFor: () =>
          Promise.resolve(
            memoryApprovalPolicies([
              { permission: "post.read", approval: "human" },
            ]).approvalPoliciesFor({ tenants: [] }),
          ),
      },
    });
    expect(
      (await gated.decide(permissions.post.read, { id: "p" })).outcome,
    ).toBe("approval-required");
  });
});
