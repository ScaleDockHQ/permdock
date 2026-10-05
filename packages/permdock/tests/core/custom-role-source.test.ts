import { describe, expect, it } from "vitest";

import type { CustomRole } from "../../src/index.ts";

import { customRoleSource } from "../../src/core/custom-role-source.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { testRoleSource } from "../../src/testing/conformance.ts";
import { customRoles, personas, policy } from "../fixtures/named-scopes.ts";

const stored: readonly CustomRole[] = [
  ...customRoles,
  { tenant: "B", name: "dispatcher", includes: ["viewer"] },
];

function reader(reads: string[] = []) {
  return {
    rolesOf(tenant: string): CustomRole[] {
      reads.push(tenant);
      return [...stored];
    },
  };
}

describe("customRoleSource", () => {
  it("returns every custom role of the requested tenant, held or not", async () => {
    const source = customRoleSource(reader());
    expect(await source.rolesFor("T", { held: ["admin"] })).toEqual(
      customRoles,
    );
    expect(await source.rolesFor("B")).toEqual([stored[1]]);
    expect(Object.keys(source)).toEqual(["rolesFor"]);
  });

  it("filters an async read and junk to the tenant", async () => {
    const source = customRoleSource({
      rolesOf: (tenant) =>
        Promise.resolve([
          // SAFETY: a store answering junk; the source must drop it.
          null as unknown as CustomRole,
          { tenant, name: "kept" },
          { tenant: "other", name: "dropped" },
        ]),
    });
    expect(await source.rolesFor("T")).toEqual([{ tenant: "T", name: "kept" }]);
  });

  it("passes assignable and globalRoles through", async () => {
    const platform: CustomRole = { scope: "global", name: "auditor" };
    const source = customRoleSource({
      rolesOf: () => [],
      assignable: (tenant) => [`admin-${tenant}`],
      globalRoles: () => [platform],
    });
    expect(await source.assignable?.("T")).toEqual(["admin-T"]);
    expect(await source.globalRoles?.()).toEqual([platform]);
  });

  it("lets assignableRoles see a custom role nobody holds", async () => {
    const admin = await createPermDock(policy, personas.admin, {
      customRoles: customRoleSource(reader()),
    });
    expect(admin.assignableRoles().map((leaf) => leaf.key)).toContain(
      "mechanic",
    );
  });

  it("skips the read with read 'held' while every held role is declared", async () => {
    const reads: string[] = [];
    const source = customRoleSource(reader(reads), { read: "held", policy });
    const admin = await createPermDock(policy, personas.admin, {
      customRoles: source,
    });
    expect(reads).toEqual([]);
    expect(admin.assignableRoles().map((leaf) => leaf.key)).not.toContain(
      "mechanic",
    );
    await createPermDock(policy, personas.mechanic, { customRoles: source });
    expect(reads).toEqual(["T"]);
  });
});

describe("testRoleSource every", () => {
  testRoleSource(customRoleSource(reader()), {
    tenant: "T",
    declared: [...policy.rolesByName.keys()],
    policy,
    every: ["mechanic"],
  });
});
