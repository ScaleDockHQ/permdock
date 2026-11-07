import { describe, expect, it } from "vitest";

import {
  ceilingGrants,
  customGrantsFor,
  customGrantsOfKey,
  indexCustomRoles,
  isCustomRoleName,
  isKnownCustomRole,
  resolveCustomRole,
  unknownLevelsFor,
} from "../../src/core/custom-roles.ts";
import { allow, deny } from "../../src/core/grant-builders.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";

const permissions = definePermissions({
  post: resource({
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});
const roles = defineRoles({
  admin: { on: "tenant" },
  viewer: { on: "tenant" },
});
const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { tenant: { key: "orgId" } },
    subject: (user: { readonly id: string } | null) =>
      user === null ? null : { id: user.id },
    roles: [
      role(roles.admin, [
        allow(permissions.post.read),
        allow(permissions.post.update),
        deny(permissions.post.update, { where: { id: "locked" } }),
      ]),
      role(roles.viewer, [allow(permissions.post.read)]),
    ],
  },
);

describe("custom role resolution index", () => {
  it("answers the same ceiling array for the same policy and scope", () => {
    expect(ceilingGrants(policy, "tenant")).toBe(
      ceilingGrants(policy, "tenant"),
    );
    expect(ceilingGrants(policy, "tenant")).toHaveLength(3);
  });

  it("keeps a restricted ceiling distinct from the full one", () => {
    const narrowed = ceilingGrants(policy, "tenant", ["viewer"]);
    expect(narrowed).toHaveLength(1);
    expect(ceilingGrants(policy, "tenant")).toHaveLength(3);
  });

  it("resolves a role to the same grants on every call", () => {
    const custom = {
      name: "reader",
      tenant: "t1",
      includes: ["admin"],
      grants: [{ permission: "post.read" }],
    };
    const first = resolveCustomRole(policy, custom);
    const second = resolveCustomRole(policy, custom);
    expect(second).toStrictEqual(first);
    expect(first.grants.length).toBeGreaterThan(0);
  });
});

describe("custom role lookup", () => {
  const many = Array.from({ length: 200 }, (_, index) => ({
    name: `c${String(index)}`,
    tenant: "t1",
    grants: [{ permission: "post.read" }],
  }));
  const lookup = indexCustomRoles(policy, many);

  it("agrees with the scanning lookups", () => {
    expect(lookup.grants).toStrictEqual(customGrantsFor(policy, many));
    expect(lookup.unknownLevels).toStrictEqual(unknownLevelsFor(policy, many));
    for (const name of ["c0", "c199", "nope"]) {
      for (const tenant of ["t1", "t2", undefined]) {
        expect(isKnownCustomRole(lookup, name, tenant)).toBe(
          isCustomRoleName(name, many, tenant),
        );
      }
    }
  });

  it("answers the grants of a key from the index", () => {
    expect(customGrantsOfKey(lookup, "post.read")).toHaveLength(
      lookup.grants.length,
    );
    expect(customGrantsOfKey(lookup, "post.update")).toHaveLength(0);
  });
});
