import { describe, expect, it } from "vitest";

import type { CustomRole, Subject } from "../../src/core/subject.ts";

import {
  customRoleClaim,
  resolveCustomRole,
  validateCustomRole,
} from "../../src/core/custom-roles.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { memoryRoleSource } from "../../src/core/interfaces.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, deny, role } from "../../src/core/policy.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";

const permissions = definePermissions({
  tenant: resource({ collection: ["read", "suspend", "delete"] }),
  invoice: resource({
    actions: ["read", "refund"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const roles = defineRoles({
  support: { assignable: true },
  billingOps: { assignable: true },
  superadmin: {},
  admin: { on: "tenant" },
});

const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { tenant: { key: "orgId" } },
    subject: (user: { readonly id: string } | null) =>
      user === null ? null : { id: user.id },
    roles: [
      role(roles.support, [allow(permissions.tenant.read)]),
      role(roles.billingOps, [
        allow(permissions.tenant.read),
        allow(permissions.tenant.suspend),
      ]),
      role(roles.superadmin, [allow(permissions.tenant.delete)]),
      role(roles.admin, [
        allow(permissions.invoice.read),
        allow(permissions.invoice.refund),
      ]),
    ],
  },
);

const platformRole: CustomRole = {
  scope: "global",
  name: "tier2",
  includes: ["support"],
  grants: [
    { permission: "tenant.suspend" },
    { permission: "tenant.delete" },
    { permission: "invoice.read" },
  ],
};

function subject(roleNames: readonly string[]): Subject {
  return {
    principal: { id: "u1", roles: roleNames, memberships: [] },
    context: {},
  };
}

describe("global custom roles", () => {
  it("are capped by the allows of assignable global roles", () => {
    expect(validateCustomRole(policy, platformRole)).toEqual({
      ok: false,
      permissions: ["tenant.read", "tenant.suspend"],
      dropped: [
        { permission: "tenant.delete", reason: "outside-ceiling" },
        { permission: "invoice.read", reason: "outside-ceiling" },
      ],
      renamed: [],
    });
    const grants = resolveCustomRole(policy, platformRole).grants;
    expect(grants.every((grant) => grant.scope === "global")).toBe(true);
    expect(grants.map((grant) => grant.to)).toContainEqual({
      kind: "role",
      role: "tier2",
      scope: "global",
    });
  });

  it("grant through principal.roles and nothing else", async () => {
    const customRoles = memoryRoleSource([platformRole]);
    const holder = await createPermDock(policy, subject(["tier2"]), {
      customRoles,
    });
    expect(holder.can(permissions.tenant.suspend)).toBe(true);
    expect(holder.can(permissions.tenant.read)).toBe(true);
    expect(holder.can(permissions.tenant.delete)).toBe(false);
    const other = await createPermDock(policy, subject([]), { customRoles });
    expect(other.can(permissions.tenant.suspend)).toBe(false);
    const viaMembership = await createPermDock(
      policy,
      {
        principal: {
          id: "u2",
          memberships: [{ scope: "tenant", id: "o1", roles: ["tier2"] }],
        },
        context: {},
      },
      { customRoles },
    );
    expect(viaMembership.can(permissions.tenant.suspend)).toBe(false);
  });

  it("ignore a platform role that carries a tenant, team or id", async () => {
    // SAFETY: deliberately malformed input to check the runtime guard.
    const forged = {
      ...platformRole,
      tenant: "o1",
    } as unknown as CustomRole;
    const permdock = await createPermDock(policy, subject(["tier2"]), {
      customRoles: { rolesFor: () => [], globalRoles: () => [forged] },
    });
    expect(permdock.can(permissions.tenant.suspend)).toBe(false);
  });

  it("read only scope: 'global' roles from globalRoles, and deny when it throws", async () => {
    const tenantRole: CustomRole = {
      tenant: "o1",
      name: "tier2",
      grants: [{ permission: "invoice.read" }],
    };
    const mixed = await createPermDock(policy, subject(["tier2"]), {
      customRoles: { rolesFor: () => [], globalRoles: () => [tenantRole] },
    });
    expect(mixed.can(permissions.tenant.suspend)).toBe(false);
    const throwing = await createPermDock(policy, subject(["tier2"]), {
      customRoles: {
        rolesFor: () => [],
        globalRoles: () => {
          throw new Error("down");
        },
      },
    });
    expect(throwing.can(permissions.tenant.suspend)).toBe(false);
    const async = await createPermDock(policy, subject(["tier2"]), {
      customRoles: {
        rolesFor: () => [],
        globalRoles: () => Promise.resolve([platformRole]),
      },
    });
    expect(async.can(permissions.tenant.suspend)).toBe(true);
  });

  it("is not loaded for an anonymous subject", async () => {
    let calls = 0;
    await createPermDock(
      policy,
      { principal: null, context: {} },
      {
        customRoles: {
          rolesFor: () => [],
          globalRoles: () => {
            calls += 1;
            return [platformRole];
          },
        },
      },
    );
    expect(calls).toBe(0);
  });

  it("reaches the snapshot and the client", () => {
    const snapshot = snapshotFor(policy, subject(["tier2"]), {
      customRoles: [platformRole],
    });
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.tenant.suspend)).toBe(true);
    expect(client.can(permissions.tenant.delete)).toBe(false);
    expect(client.assignablePermissions({ scope: "global" })).toEqual([]);
  });

  it("lists the global ceiling the subject may hand out", async () => {
    const ops = await createPermDock(policy, subject(["billingOps"]));
    expect(
      ops.assignablePermissions({ scope: "global" }).map((leaf) => leaf.key),
    ).toEqual(["tenant.read", "tenant.suspend"]);
    const support = await createPermDock(policy, subject(["support"]));
    expect(
      support
        .assignablePermissions({ scope: "global" })
        .map((leaf) => leaf.key),
    ).toEqual(["tenant.read"]);
    const nobody = await createPermDock(policy, subject(["superadmin"]));
    expect(nobody.assignablePermissions({ scope: "global" })).toEqual([]);
  });

  it("keeps a deny of the role's own scope", () => {
    const withDeny = definePolicy(
      { permissions, roles },
      {
        scopes: { tenant: { key: "orgId" } },
        subject: () => null,
        roles: [
          role(roles.billingOps, [
            allow(permissions.tenant.read),
            allow(permissions.tenant.suspend),
          ]),
          role(roles.support, [
            allow(permissions.tenant.read),
            deny(permissions.tenant.suspend),
          ]),
        ],
      },
    );
    const resolved = resolveCustomRole(withDeny, {
      scope: "global",
      name: "mixed",
      includes: ["support"],
      grants: [{ permission: "tenant.suspend" }],
    });
    expect(
      resolved.grants.map((grant) => `${grant.effect} ${grant.permission.key}`),
    ).toEqual(
      expect.arrayContaining(["allow tenant.read", "deny tenant.suspend"]),
    );
  });

  it("write the claim under the role name", () => {
    expect(customRoleClaim([platformRole])).toEqual({
      tier2: ["@support", "tenant.suspend", "tenant.delete", "invoice.read"],
    });
  });
});
