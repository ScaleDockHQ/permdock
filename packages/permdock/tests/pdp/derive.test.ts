import { describe, expect, it } from "vitest";

import {
  approvalPolicies,
  memoryApprovalPolicySource,
} from "../../src/core/approval-policies.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { getPermDockSync } from "../../src/pdp/index.ts";

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
    const permdock = getPermDockSync(policy, {
      id: "u1",
      roles: ["member"],
    });
    const same = await permdock.derive({});
    expect(await same.can(permissions.post.read, { id: "p" })).toBe(true);
    const gated = await permdock.derive({
      approvalPolicies: approvalPolicies({
        approvalPoliciesFor: () =>
          Promise.resolve(
            memoryApprovalPolicySource([
              { permission: "post.read", approval: "human" },
            ]).approvalPoliciesFor({ tenants: [] }),
          ),
      }),
    });
    expect(
      (await gated.decide(permissions.post.read, { id: "p" })).outcome,
    ).toBe("approval-required");
  });
});
