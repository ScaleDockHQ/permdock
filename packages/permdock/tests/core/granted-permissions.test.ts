import { describe, expect, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";
import type { Permission } from "../../src/core/permission-types.ts";
import type { Principal } from "../../src/core/subject.ts";

import { isGlobalPermission } from "../../src/core/granted-permissions.ts";
import { memoryCustomRoleSource } from "../../src/core/memory-sources.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import {
  customRoles,
  permissions,
  personas,
  policy,
} from "../fixtures/named-scopes.ts";

const permdockFor = (
  principal: Principal,
  options: { readonly tenant?: string } = {},
): PermDock =>
  getPermDockSync(policy, principal, {
    customRoles: memoryCustomRoleSource(customRoles),
    ...options,
  });

const keys = (
  permdock: PermDock,
  options?: Parameters<PermDock["grantedPermissions"]>[0],
): string[] =>
  permdock
    .grantedPermissions(options)
    .map((permission) => permission.key)
    .toSorted();

describe("memberships filter", () => {
  const permdock = permdockFor(personas.staffContact);

  it("returns every membership without a filter", () => {
    expect(permdock.memberships()).toHaveLength(2);
  });

  it("filters by via, an open union that matches staff", () => {
    expect(
      permdock.memberships({ via: "staff" }).map((entry) => entry.id),
    ).toStrictEqual(["T"]);
    expect(
      permdock.memberships({ via: "contact" }).map((entry) => entry.id),
    ).toStrictEqual(["C"]);
    expect(permdock.memberships({ via: "unknown-source" })).toStrictEqual([]);
  });

  it("filters by scope and combines both filters", () => {
    expect(
      permdock.memberships({ scope: "customer" }).map((entry) => entry.id),
    ).toStrictEqual(["C"]);
    expect(
      permdock.memberships({ scope: "customer", via: "staff" }),
    ).toStrictEqual([]);
  });
});

describe(isGlobalPermission, () => {
  it("is true when only global roles allow the key", () => {
    expect(isGlobalPermission(policy, permissions.organization.disable)).toBe(
      true,
    );
    expect(isGlobalPermission(policy, permissions.organization.list)).toBe(
      true,
    );
  });

  it("is false when a scoped role allows the key", () => {
    expect(isGlobalPermission(policy, permissions.quote.read)).toBe(false);
  });

  it("is false for a key no grant allows", () => {
    expect(isGlobalPermission(policy, permissions.quote.accept)).toBe(false);
    expect(isGlobalPermission(policy, permissions.invoice.pay)).toBe(false);
  });
});

describe("grantedPermissions", () => {
  it("lists the keys a viewer holds in the active tenant", () => {
    expect(keys(permdockFor(personas.viewer))).toStrictEqual([
      "asset.read",
      "invoice.read",
      "quote.read",
    ]);
  });

  it("agrees with a type-level can() for every declared permission", () => {
    for (const persona of Object.values(personas)) {
      const permdock = permdockFor(persona);
      const listed = new Set(keys(permdock));
      for (const leaf of [
        ...Object.values(permissions.quote),
        ...Object.values(permissions.invoice),
        ...Object.values(permissions.asset),
        ...Object.values(permissions.organization),
      ]) {
        // SAFETY: every value of these resources is a Permission leaf.
        const permission = leaf as Permission;
        // SAFETY: a rowless check of any leaf is the type-level check under test.
        const granted = permdock.can(permission as never);
        expect(
          listed.has(permission.key),
          `${persona.id} ${permission.key}`,
        ).toBe(granted);
      }
    }
  });

  it("lists nothing for another tenant the caller does not hold", () => {
    expect(keys(permdockFor(personas.owner), { tenant: "Z" })).toStrictEqual(
      [],
    );
  });

  it("lists the permissions of another held tenant", () => {
    const owner = permdockFor(personas.owner);
    expect(keys(owner, { tenant: "B" })).toStrictEqual(keys(owner.tenant("B")));
    expect(keys(owner, { tenant: "B" })).toContain("quote.delete");
  });

  it("lists global permissions with no tenant", () => {
    expect(keys(permdockFor(personas.platformSupport))).toStrictEqual([
      "organization.list",
      "organization.read",
    ]);
  });

  it("drops a permission a custom role denies", () => {
    const mechanic = keys(permdockFor(personas.mechanic));
    expect(mechanic).toContain("asset.update");
    expect(mechanic).not.toContain("asset.delete");
    expect(mechanic).not.toContain("quote.read");
  });

  it("narrows to one scope instance", () => {
    const staffContact = permdockFor(personas.staffContact);
    expect(
      keys(staffContact, { tenant: "B", scope: "customer", id: "C" }),
    ).toStrictEqual(["asset.read"]);
    expect(
      keys(staffContact, { tenant: "T", scope: "customer", id: "C" }),
    ).toStrictEqual([]);
  });
});
