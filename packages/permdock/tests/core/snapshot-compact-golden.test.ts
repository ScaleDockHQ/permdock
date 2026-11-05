import { describe, expect, it } from "vitest";

import type { Permission } from "../../src/core/permission-types.ts";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { grantedPermissionsOf } from "../../src/core/granted-permissions.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import {
  adminOf,
  mixed,
  permissions,
  policy,
  rowsFor,
  TENANTS,
} from "../fixtures/large-policy.ts";

const ACTIONS = [
  "read",
  "create",
  "update",
  "delete",
  "export",
  "archive",
  "assign",
] as const;

type Leaf = Permission<string, unknown, "instance">;

function leaves(): readonly Leaf[] {
  return Object.values(permissions).flatMap((node) =>
    ACTIONS.map((action): Leaf => node[action]),
  );
}

function plain(snapshot: unknown): string {
  if (snapshot instanceof Promise) {
    throw new TypeError("expected an unsigned snapshot");
  }
  return JSON.stringify(snapshot);
}

describe("snapshot v2 round trip over a large policy", () => {
  it("has 273 leaves and 1,790 admin grants", () => {
    expect(leaves()).toHaveLength(273);
    const server = getPermDockSync(policy, adminOf("o0"), { tenant: "o0" });
    const v1 = parseSnapshot(plain(server.snapshot({ v: 1 })));
    expect(v1.grants).toHaveLength(1790);
  });

  it.each(TENANTS)("answers alike for the admin of %s", (tenant) => {
    const user = adminOf(tenant);
    const server = getPermDockSync(policy, user, { tenant });
    const v1 = parseSnapshot(plain(server.snapshot({ v: 1 })));
    const v2 = parseSnapshot(plain(server.snapshot()));
    expect({ ...v2, issuedAt: v1.issuedAt }).toStrictEqual(v1);
    const before = fromSnapshot(v1);
    const after = fromSnapshot(v2);
    for (const leaf of leaves()) {
      for (const row of rowsFor(tenant, user.id)) {
        expect(after.can(leaf, row)).toBe(before.can(leaf, row));
        expect(after.can(leaf, row)).toBe(server.can(leaf, row));
        // The approval token of a decision carries a per-instance nonce.
        const decided = (
          decision: ReturnType<typeof after.decide>,
        ): object => ({ ...decision, token: undefined });
        expect(decided(after.decide(leaf, row))).toStrictEqual(
          decided(before.decide(leaf, row)),
        );
      }
      // SAFETY: a rowless check reads the type-level table; the leaf is an instance permission.
      const rowless = (instance: typeof after): boolean =>
        (instance.can as unknown as (permission: Leaf) => boolean)(leaf);
      expect(rowless(after)).toBe(rowless(before));
    }
    expect(
      grantedPermissionsOf(policy, v2).map((leaf) => leaf.key),
    ).toStrictEqual(server.grantedPermissions().map((leaf) => leaf.key));
    expect(
      grantedPermissionsOf(policy, v2).map((leaf) => leaf.key),
    ).toStrictEqual(grantedPermissionsOf(policy, v1).map((leaf) => leaf.key));
  });

  it("keeps a subject with an admin and viewer memberships", () => {
    const server = getPermDockSync(policy, mixed(), { tenant: "o0" });
    const v1 = parseSnapshot(plain(server.snapshot({ v: 1, tenants: "all" })));
    const v2 = parseSnapshot(plain(server.snapshot({ tenants: "all" })));
    expect({ ...v2, issuedAt: v1.issuedAt }).toStrictEqual(v1);
    for (const tenant of TENANTS) {
      const before = fromSnapshot(v1).team(tenant);
      const after = fromSnapshot(v2).team(tenant);
      for (const leaf of leaves()) {
        for (const row of rowsFor(tenant, "u-mixed")) {
          expect(after.can(leaf, row)).toBe(before.can(leaf, row));
        }
      }
    }
  });
});
