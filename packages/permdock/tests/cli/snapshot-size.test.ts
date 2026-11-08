import { describe, expect, it } from "vitest";

import { pd112 } from "../../src/cli/doctor/perf-snapshot.ts";
import {
  mostPrivilegedRole,
  runSnapshotSize,
  snapshotSize,
} from "../../src/cli/snapshot-size.ts";
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

function policyOf(resources: number) {
  const permissions = definePermissions(
    Object.fromEntries(
      Array.from({ length: resources }, (_, index) => [
        `thing${String(index)}`,
        resource(Row, {
          id: "id",
          actions: ["read", "create", "update", "delete"],
          relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
        }),
      ]),
    ),
  );
  const leaves = Object.values(permissions).flatMap((node) =>
    Object.values(node),
  );
  return definePolicy(permissions, {
    scopes: { tenant: { key: "tenant_id" } },
    // SAFETY: the size probe never calls the subject mapper.
    subject: (user: unknown) => user as never,
    roles: [
      role("viewer", [], { on: "tenant" }),
      // SAFETY: each leaf is a permission reference of the policy above.
      role(
        "owner",
        leaves.map((leaf) => allow(leaf as never)),
        { on: "tenant" },
      ),
    ],
  });
}

describe("snapshot size", () => {
  it("measures the role with the most grants by default", () => {
    expect(mostPrivilegedRole(policyOf(2))).toBe("owner");
  });

  it("reports every part and names the largest", () => {
    const report = snapshotSize({
      policy: policyOf(3),
      role: "owner",
      tenants: 2,
      omitAssignable: false,
    });
    if (typeof report === "string") {
      throw new TypeError(report);
    }
    expect(report.total.bytes).toBeGreaterThan(0);
    expect(report.parts.map((part) => part.part)).toContain("grants");
    expect(report.largest).not.toBe("none");
  });

  it("reports the grants per membership and shrinks them with omitStatic", () => {
    const measure = (omitStatic: boolean) => {
      const report = snapshotSize({
        policy: policyOf(3),
        role: "owner",
        tenants: 4,
        omitAssignable: true,
        omitStatic,
      });
      if (typeof report === "string") {
        throw new TypeError(report);
      }
      return report;
    };
    const full = measure(false);
    const lean = measure(true);
    expect(full.perMembership).toBeGreaterThan(0);
    expect(lean.perMembership).toBeLessThan(full.perMembership ?? 0);
    expect(lean.parts.map((part) => part.part)).toContain("static");
  });

  it("answers an unknown role as a usage error", () => {
    const result = runSnapshotSize({
      policy: policyOf(1),
      role: "nobody",
      tenants: 1,
      omitAssignable: false,
      budget: 100,
      json: false,
    });
    expect(result.code).toBe(2);
  });

  it("flags a snapshot over the budget in text and data", () => {
    const result = runSnapshotSize({
      policy: policyOf(3),
      role: "owner",
      tenants: 1,
      omitAssignable: false,
      budget: 10,
      json: false,
    });
    expect(result.output).toContain("over the 10 byte budget");
  });
});

describe("PD112 snapshot size", () => {
  it("passes a small policy", async () => {
    const policy = policyOf(2);
    expect(
      await pd112({ policy: () => Promise.resolve(policy) }),
    ).toStrictEqual([]);
  });

  it("skips a project with no policy", async () => {
    expect(
      await pd112({ policy: () => Promise.resolve(undefined) }),
    ).toStrictEqual([]);
  });

  it("warns for the role with the most grants once it exceeds 64 KB", async () => {
    const policy = policyOf(600);
    const findings = await pd112({ policy: () => Promise.resolve(policy) });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("PD112");
    expect(findings[0]?.message).toContain("the largest part is");
  });
});

describe("snapshot size edge cases", () => {
  it("refuses a role held on a resource and a policy with no roles", () => {
    // SAFETY: a minimal policy shape; snapshotSize reads roles and scopes before it refuses.
    const onResource = {
      roles: [{ name: "owner", on: { resource: "x" }, grants: [] }],
      scopes: [],
    } as unknown as ReturnType<typeof policyOf>;
    expect(
      snapshotSize({
        policy: onResource,
        role: "owner",
        tenants: 1,
        omitAssignable: false,
      }),
    ).toContain("held on a resource");
    // SAFETY: a policy with no roles; the command refuses before it reads anything else.
    const empty = { roles: [] } as unknown as ReturnType<typeof policyOf>;
    expect(
      runSnapshotSize({
        policy: empty,
        role: undefined,
        tenants: 1,
        omitAssignable: false,
        budget: 1,
        json: false,
      }).code,
    ).toBe(2);
  });
});

describe("snapshot size by role shape", () => {
  const permissions = definePermissions({
    note: resource(Row, {
      id: "id",
      actions: ["read"],
      relations: {
        tenant: { field: "tenant_id", memberOf: "tenant" },
        team: { field: "team_id", memberOf: "team" },
      },
    }),
  });
  const nested = definePolicy(permissions, {
    scopes: {
      tenant: { key: "tenant_id" },
      team: { key: "team_id", within: "tenant" },
    },
    // SAFETY: the size probe never calls the subject mapper.
    subject: (user: unknown) => user as never,
    roles: [
      role("lead", [allow(permissions.note.read)], { on: "team" }),
      role("support", [allow(permissions.note.read)]),
    ],
  });

  it("gives a role held on a nested scope a membership inside the root", () => {
    const report = snapshotSize({
      policy: nested,
      role: "lead",
      tenants: 2,
      omitAssignable: true,
    });
    if (typeof report === "string") {
      throw new TypeError(report);
    }
    expect(report.scope).toBe("team");
    expect(report.tenants).toBe(2);
  });

  it("measures a global role with no memberships and picks the first of equals", () => {
    const report = snapshotSize({
      policy: nested,
      role: "support",
      tenants: 5,
      omitAssignable: false,
    });
    if (typeof report === "string") {
      throw new TypeError(report);
    }
    expect(report.scope).toBeNull();
    expect(report.tenants).toBe(0);
    expect(mostPrivilegedRole(nested)).toBe("lead");
  });
});
