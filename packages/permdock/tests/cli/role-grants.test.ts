import { describe, expect, it } from "vitest";

import { roleGrants, runRoleGrants } from "../../src/cli/role-grants.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

const Row = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  invoice: resource(Row, {
    id: "id",
    actions: ["read", "update"],
    relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "tenant_id" } },
  // SAFETY: the listing never calls the subject mapper.
  subject: (user: unknown) => user as never,
  roles: [
    role("admin", [allow(permissions.invoice)], { on: "tenant" }),
    role("viewer", [allow(permissions.invoice.read)], { on: "tenant" }),
  ],
});

describe("roles grants", () => {
  it("expands a resource grant to one row per leaf", () => {
    const reports = roleGrants(policy, "admin");
    if (typeof reports === "string") {
      throw new TypeError(reports);
    }
    expect(reports[0]?.grants.map((grant) => grant.permission)).toStrictEqual([
      "invoice.read",
      "invoice.update",
    ]);
    expect(reports[0]?.scope).toBe("tenant");
  });

  it("lists every role without --role and prints text rows", () => {
    const result = runRoleGrants({ policy, role: undefined, json: false });
    expect(result.code).toBe(0);
    expect(result.output).toContain("viewer (on tenant): 1 grants");
    expect(result.output).toContain("allow invoice.update");
  });

  it("answers an unknown role as a usage error", () => {
    expect(runRoleGrants({ policy, role: "nobody", json: false }).code).toBe(2);
  });
});

describe("roles grants notes", () => {
  it("marks each grant that carries a condition, approval, limit or fields", () => {
    const leaf = { key: "x.read" };
    // SAFETY: a minimal policy shape; roleGrants reads only roles, grants and their notes.
    const fake = {
      roles: [
        {
          name: "r",
          on: undefined,
          grants: [
            {
              permission: leaf,
              effect: "deny",
              where: {},
              check: {},
              approval: "human",
              limit: {},
              fields: ["a"],
            },
          ],
        },
      ],
    } as unknown as typeof policy;
    const reports = roleGrants(fake, undefined);
    if (typeof reports === "string") {
      throw new TypeError(reports);
    }
    expect(reports[0]?.grants[0]?.notes).toStrictEqual([
      "where",
      "check",
      "approval",
      "limit",
      "fields",
    ]);
    expect(reports[0]?.scope).toBeNull();
    // SAFETY: a policy with no roles; roleGrants reads only the role list.
    const empty = { roles: [] } as unknown as typeof policy;
    expect(roleGrants(empty, undefined)).toBe("the policy declares no role");
  });
});
