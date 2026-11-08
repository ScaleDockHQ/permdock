import { describe, expect, it } from "vitest";

import type { CustomRole } from "../../src/index.ts";

import {
  claimsFirst,
  getPermDock,
  instanceCache,
  memoryMembershipSource,
} from "../../src/index.ts";
import { permissions, policy } from "../fixtures/named-scopes.ts";

const asset = { id: "a1", organization_id: "acme", customer_id: "c1" };

const principal = {
  id: "u1",
  tenant: "acme",
  memberships: [
    { scope: "organization", id: "acme", roles: ["auditor"], via: "staff" },
  ],
  authzVersion: 4,
  customRolesVersion: 1,
};

/** A source whose custom role loses its grant when `edit()` runs. */
function world() {
  let version = 1;
  let grants = [{ permission: "asset.read" }];
  const reads = { roles: 0, versions: 0 };
  const base = memoryMembershipSource({ u1: principal.memberships });
  return {
    reads,
    edit() {
      version += 1;
      grants = [];
    },
    memberships: claimsFirst(
      {
        ...base,
        version: () => 4,
        customRolesVersion: () => {
          reads.versions += 1;
          return version;
        },
      },
      { onStale: "reread" },
    ),
    customRoles: {
      rolesFor(): CustomRole[] {
        reads.roles += 1;
        return [
          { name: "auditor", tenant: "acme", scope: "organization", grants },
        ];
      },
    },
  };
}

describe("the instance cache and the tenant's custom-role version", () => {
  it("rebuilds the instance when an edit raised the version", async () => {
    const instances = instanceCache();
    const db = world();
    const decide = async (claimed: number): Promise<boolean> => {
      const permdock = await getPermDock(
        policy,
        {
          principal: { ...principal, customRolesVersion: claimed },
          context: {},
        },
        {
          tenant: "acme",
          instances,
          memberships: db.memberships,
          customRoles: db.customRoles,
        },
      );
      return permdock.can(permissions.asset.read, asset);
    };
    expect(await decide(1)).toBe(true);
    expect(await decide(1)).toBe(true);
    expect(db.reads.roles).toBe(1);
    db.edit();
    expect(await decide(2)).toBe(false);
    expect(db.reads.roles).toBe(2);
  });

  it("keeps a subject with no custom role out of the version read", async () => {
    const instances = instanceCache();
    const db = world();
    const plain = {
      ...principal,
      memberships: [
        { scope: "organization", id: "acme", roles: ["owner"], via: "staff" },
      ],
    };
    await getPermDock(
      policy,
      { principal: plain, context: {} },
      {
        tenant: "acme",
        instances,
        memberships: db.memberships,
        customRoles: db.customRoles,
      },
    );
    expect(db.reads.versions).toBe(0);
  });
});
