import { describe, expect, it } from "vitest";

import type { Policy } from "../../src/core/policy-types.ts";

import { allow } from "../../src/core/grant-builders.ts";
import {
  evaluateGrantCondition,
  isDelegatedPermission,
} from "../../src/core/grant-conditions.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";

const tree = definePermissions({
  doc: resource({
    collection: ["list"],
    actions: ["read"],
    relations: { owner: { field: "ownerId" } },
  }),
});

const subject = { principal: null, context: {} };
const now = 1_700_000_000;

function policyFor(grants: readonly ReturnType<typeof allow>[]) {
  return definePolicy(tree, {
    subject: () => null,
    roles: [role("reader", grants)],
  });
}

describe("grant condition edges", () => {
  it("refuses a collection condition and a related read with no source", () => {
    const related = policyFor([
      allow(tree.doc.read, {
        where: {
          op: "related",
          resource: "doc",
          relation: "owner",
          field: "id",
        },
      }),
    ]);
    const grant = related.grants[0];
    if (grant === undefined) {
      throw new Error("expected a grant");
    }
    expect(
      evaluateGrantCondition(
        grant,
        tree.doc.read,
        { id: "a" },
        undefined,
        subject,
        now,
        related.scopes,
        undefined,
      ),
    ).toStrictEqual({ matched: false, reason: "relation-unavailable" });
    expect(
      evaluateGrantCondition(
        grant,
        tree.doc.list,
        { id: "a" },
        undefined,
        subject,
        now,
        related.scopes,
        undefined,
      ),
    ).toStrictEqual({ matched: false, reason: "condition" });
  });

  it("is not delegated when no provider handles the permission", () => {
    const policy = policyFor([allow(tree.doc.read)]);
    expect(isDelegatedPermission(policy, tree.doc.read)).toBe(false);
    // SAFETY: only handles is called, and it declines the permission.
    const declined = {
      ...policy,
      providers: [{ handles: () => false }],
    } as unknown as Policy;
    expect(isDelegatedPermission(declined, tree.doc.read)).toBe(false);
  });
});
