import { describe, expect, it } from "vitest";

import type { RoleSource } from "../../src/core/interfaces.ts";
import type { Subject } from "../../src/core/subject.ts";

import { memoryApprovalPolicies } from "../../src/core/approval-policies.ts";
import { createPermDock, fromSnapshot } from "../../src/core/permdock.ts";
import { permissions, policy, rows } from "../fixtures/expenses.ts";
import {
  customRoles as mechanic,
  permissions as scoped,
  policy as scopedPolicy,
} from "../fixtures/named-scopes.ts";

const [large] = rows.expense;

const alice: Subject = {
  principal: {
    id: "alice",
    tenant: "o1",
    memberships: [{ scope: "tenant", id: "o1", roles: ["member"] }],
  },
  context: {},
};

describe("permdock.derive", () => {
  it("adds approval policies and keeps the subject and tenant", async () => {
    const permdock = await createPermDock(policy, alice);
    expect(permdock.decide(permissions.expense.read, large).outcome).toBe(
      "granted",
    );
    const derived = await permdock.derive({
      approvalPolicies: memoryApprovalPolicies([
        {
          permission: "expense.read",
          tenant: "o1",
          where: { op: "gt", field: "amount", value: 1000 },
          approval: { by: "finance" },
        },
      ]),
    });
    expect(derived.decide(permissions.expense.read, large).outcome).toBe(
      "approval-required",
    );
    expect(derived.subject).toBe(permdock.subject);
    expect(permdock.decide(permissions.expense.read, large).outcome).toBe(
      "granted",
    );
  });

  it("reads a new custom-role source for the subject's tenants, synchronously when it answers so", async () => {
    const subject: Subject = {
      principal: {
        id: "u1",
        memberships: [
          { scope: "organization", id: "T", roles: ["mechanic"], via: "staff" },
        ],
      },
      context: {},
    };
    const asked: string[] = [];
    const source: RoleSource = {
      rolesFor(tenant) {
        asked.push(tenant);
        return mechanic.filter((role) => role.tenant === tenant);
      },
    };
    const permdock = await createPermDock(scopedPolicy, subject);
    const asset = { id: "a", organization_id: "T", customer_id: "c" };
    expect(permdock.tenant("T").can(scoped.asset.read, asset)).toBe(false);
    const derived = permdock.tenant("T").derive({ customRoles: source });
    if (derived instanceof Promise) {
      throw new TypeError("expected a synchronous instance");
    }
    expect(asked).toEqual(["T"]);
    expect(derived.subject.principal?.tenant).toBe("T");
    expect(derived.can(scoped.asset.read, asset)).toBe(true);
    expect(derived.can(scoped.asset.delete, asset)).toBe(false);
  });

  it("returns a promise for an async source and keeps loaded roles otherwise", async () => {
    const permdock = await createPermDock(
      scopedPolicy,
      {
        principal: {
          id: "u1",
          memberships: [
            {
              scope: "organization",
              id: "T",
              roles: ["mechanic"],
              via: "staff",
            },
          ],
        },
        context: {},
      },
      {
        customRoles: { rolesFor: () => Promise.resolve([...mechanic]) },
      },
    );
    const derived = permdock.derive({});
    if (derived instanceof Promise) {
      throw new TypeError("expected a synchronous instance");
    }
    const asset = { id: "a", organization_id: "T", customer_id: "c" };
    expect(derived.tenant("T").can(scoped.asset.read, asset)).toBe(true);
    await expect(
      permdock.derive({ customRoles: { rolesFor: () => Promise.resolve([]) } }),
    ).resolves.toBeDefined();
  });
});

describe("derive on other instances", () => {
  it("returns a snapshot instance itself", async () => {
    const permdock = await createPermDock(policy, alice);
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected an unsigned snapshot");
    }
    const local = fromSnapshot(snapshot);
    expect(local.derive({ customRoles: { rolesFor: () => [] } })).toBe(local);
  });

  it("reads no custom roles from a source whose promise rejects", async () => {
    const events: unknown[] = [];
    const permdock = await createPermDock(scopedPolicy, {
      principal: {
        id: "u1",
        memberships: [
          { scope: "organization", id: "T", roles: ["mechanic"], via: "staff" },
        ],
      },
      context: {},
    });
    const derived = await permdock.derive({
      customRoles: { rolesFor: () => Promise.reject(new Error("down")) },
    });
    derived.on("auth", (event) => {
      events.push(event);
    });
    expect(events).toEqual([{ reason: "source-threw", source: "customRoles" }]);
  });
});
