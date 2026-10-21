import { describe, expect, it } from "vitest";

import type { CustomRole } from "../../src/index.ts";

import { customRoleSource } from "../../src/core/custom-role-source.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { testCustomRoleSource } from "../../src/testing/conformance/identity.ts";
import { customRoles, personas, policy } from "../fixtures/named-scopes.ts";

const stored: readonly CustomRole[] = [
  ...customRoles,
  { tenant: "B", name: "dispatcher", includes: ["viewer"] },
];

function reader(reads: string[] = []) {
  return {
    rolesFor(tenant: string): CustomRole[] {
      reads.push(tenant);
      return [...stored];
    },
  };
}

describe("customRoleSource", () => {
  it("returns every custom role of the requested tenant, held or not", async () => {
    const source = customRoleSource(reader());
    expect(await source.rolesFor("T", { held: ["admin"] })).toStrictEqual(
      customRoles,
    );
    expect(await source.rolesFor("B")).toStrictEqual([stored[1]]);
    expect(Object.keys(source)).toStrictEqual(["rolesFor"]);
  });

  it("filters an async read and junk to the tenant", async () => {
    const source = customRoleSource({
      rolesFor: (tenant) =>
        Promise.resolve([
          // SAFETY: a store answering junk; the source must drop it.
          null as unknown as CustomRole,
          { tenant, name: "kept" },
          { tenant: "other", name: "dropped" },
        ]),
    });
    expect(await source.rolesFor("T")).toStrictEqual([
      { tenant: "T", name: "kept" },
    ]);
  });

  it("passes assignable and globalRoles through", async () => {
    const platform: CustomRole = { scope: "global", name: "auditor" };
    const source = customRoleSource({
      rolesFor: () => [],
      assignable: (tenant) => [`admin-${tenant}`],
      globalRoles: () => [platform],
    });
    expect(await source.assignable?.("T")).toStrictEqual(["admin-T"]);
    expect(await source.globalRoles?.()).toStrictEqual([platform]);
  });

  it("lets assignableRoles see a custom role nobody holds", async () => {
    const admin = getPermDockSync(policy, personas.admin, {
      customRoles: customRoleSource(reader()),
    });
    expect(admin.assignableRoles().map((leaf) => leaf.key)).toContain(
      "mechanic",
    );
  });

  it("skips the read with read 'held' while every held role is declared", async () => {
    const reads: string[] = [];
    const source = customRoleSource(reader(reads), { read: "held", policy });
    const admin = getPermDockSync(policy, personas.admin, {
      customRoles: source,
    });
    expect(reads).toStrictEqual([]);
    expect(admin.assignableRoles().map((leaf) => leaf.key)).not.toContain(
      "mechanic",
    );
    getPermDockSync(policy, personas.mechanic, { customRoles: source });
    expect(reads).toStrictEqual(["T"]);
  });

  it("skips the platform read with read 'held' while every held global role is declared", async () => {
    const platform: CustomRole = { scope: "global", name: "auditor" };
    const reads: string[] = [];
    const source = customRoleSource(
      {
        rolesFor: () => [],
        globalRoles: () => {
          reads.push("global");
          return [platform];
        },
      },
      { read: "held", policy },
    );
    getPermDockSync(
      policy,
      { principal: { id: "p1", roles: ["platform-admin"] }, context: {} },
      { customRoles: source },
    );
    expect(reads).toStrictEqual([]);
    getPermDockSync(
      policy,
      { principal: { id: "p2", roles: ["auditor"] }, context: {} },
      { customRoles: source },
    );
    expect(reads).toStrictEqual(["global"]);
    getPermDockSync(policy, null, { customRoles: source });
    expect(reads).toStrictEqual(["global"]);
    expect(await source.globalRoles?.()).toStrictEqual([platform]);
  });
});

describe("testCustomRoleSource every", () => {
  testCustomRoleSource(customRoleSource(reader()), {
    tenant: "T",
    declared: [...policy.rolesByName.keys()],
    policy,
    every: ["mechanic"],
  });
});
