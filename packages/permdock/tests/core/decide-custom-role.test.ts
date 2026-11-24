import { describe, expect, it } from "vitest";

import type {
  CustomRole,
  CustomRoleGrant,
  Membership,
} from "../../src/core/subject.ts";

import { principal } from "../../src/conditions/refs.ts";
import { decideCustomRole } from "../../src/core/decide-custom-role.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { memoryCustomRoleSource } from "../../src/core/memory-sources.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";

const permissions = definePermissions({
  task: resource({
    id: "id",
    actions: ["read", "update", "delete"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
    levels: { own: { ownerId: principal.id }, all: {} },
  }),
  billing: resource({ collection: ["manage"] }),
  platform: resource({ collection: ["read"] }),
  member: resource({ collection: { assignRole: { manageRoles: true } } }),
});

const roles = defineRoles({
  owner: { on: "tenant", assignable: false },
  admin: { on: "tenant" },
  member: { on: "tenant" },
  support: { assignable: true },
});

const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { tenant: { key: "orgId" } },
    subject: (user: { readonly id: string } | null) =>
      user === null ? null : { id: user.id },
    roles: [
      role(roles.owner, [
        allow(permissions.billing.manage),
        allow(permissions.member.assignRole),
      ]),
      role(roles.admin, [
        allow(permissions.task.read),
        allow(permissions.task.update),
        allow(permissions.task.delete),
      ]),
      role(roles.member, [
        allow(permissions.task.read, { where: { ownerId: principal.id } }),
        allow(permissions.task.update, { where: { ownerId: principal.id } }),
      ]),
      role(roles.support, [allow(permissions.platform.read)]),
    ],
  },
);

function editor(
  memberships: readonly Membership[],
  customRoles: readonly CustomRole[] = [],
  globalRoles: readonly string[] = [],
) {
  return getPermDockSync(
    policy,
    {
      principal: { id: "u1", memberships, roles: globalRoles, tenant: "acme" },
      context: {},
    },
    { tenant: "acme", customRoles: memoryCustomRoleSource(customRoles) },
  );
}

const admin = editor([{ scope: "tenant", id: "acme", roles: ["admin"] }]);

function planner(
  grants: readonly CustomRoleGrant[],
  tenant = "acme",
): CustomRole {
  return { tenant, name: "planner", grants };
}

describe(decideCustomRole, () => {
  it("grants a role within the ceiling and what the editor holds", () => {
    const decision = decideCustomRole(
      admin,
      planner([{ permission: "task.read" }, { permission: "task.update" }]),
    );
    expect(decision).toStrictEqual({
      outcome: "granted",
      role: planner([
        { permission: "task.read" },
        { permission: "task.update" },
      ]),
      permissions: ["task.read", "task.update"],
      renamed: [],
    });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("denies a permission the editor does not hold with not-assignable-by", () => {
    const member = editor([{ scope: "tenant", id: "acme", roles: ["member"] }]);
    const decision = decideCustomRole(
      member,
      planner([{ permission: "task.read" }, { permission: "task.delete" }]),
    );
    expect(decision.outcome).toBe("denied");
    expect(decision.outcome === "denied" && decision.beyond).toStrictEqual([
      "task.delete",
    ]);
    expect(decision.outcome === "denied" && decision.denials).toStrictEqual([
      {
        role: "planner",
        reason: "not-assignable-by",
        detail: { beyond: ["task.delete"] },
      },
    ]);
  });

  it("denies a level wider than the one the editor holds", () => {
    const member = editor([{ scope: "tenant", id: "acme", roles: ["member"] }]);
    expect(
      decideCustomRole(
        member,
        planner([{ permission: "task.read", level: "own" }]),
      ).outcome,
    ).toBe("granted");
    const wider = decideCustomRole(
      member,
      planner([{ permission: "task.read", level: "all" }]),
    );
    expect(wider.outcome === "denied" && wider.beyond).toStrictEqual([
      "task.read@all",
    ]);
  });

  it("denies a permission above the ceiling with validation and the drop", () => {
    const owner = editor([{ scope: "tenant", id: "acme", roles: ["owner"] }]);
    const decision = decideCustomRole(
      owner,
      planner([{ permission: "task.read" }, { permission: "billing.manage" }]),
    );
    expect(decision.outcome === "denied" && decision.dropped).toStrictEqual([
      { permission: "billing.manage", reason: "outside-ceiling" },
    ]);
    expect(
      decision.outcome === "denied" &&
        decision.denials.map((denial) => denial.reason),
    ).toStrictEqual(["validation"]);
  });

  it("denies an unknown key", () => {
    const decision = decideCustomRole(
      admin,
      planner([{ permission: "task.teleport" }]),
    );
    expect(decision.outcome === "denied" && decision.dropped).toStrictEqual([
      { permission: "task.teleport", reason: "unknown-permission" },
    ]);
  });

  it("denies every role in a tenant where the editor may hand out nothing", () => {
    expect(decideCustomRole(admin, planner([], "globex"))).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "not-assignable-by" }],
    });
    expect(
      decideCustomRole(admin, planner([{ permission: "task.read" }], "globex"))
        .outcome,
    ).toBe("denied");
  });

  it("denies the name of a shared role the instance sees", () => {
    const shared: CustomRole = {
      shared: true,
      name: "planner",
      grants: [{ permission: "task.read" }],
    };
    const withShared = editor(
      [{ scope: "tenant", id: "acme", roles: ["admin"] }],
      [shared],
    );
    expect(
      decideCustomRole(withShared, planner([{ permission: "task.read" }])),
    ).toMatchObject({
      outcome: "denied",
      dropped: [{ role: "planner", reason: "name-taken" }],
    });
  });

  it("caps a platform role at the global roles the editor may hand out", () => {
    const platform = editor([], [], ["support"]);
    const tier: CustomRole = {
      scope: "global",
      name: "tier-2",
      grants: [{ permission: "platform.read" }],
    };
    expect(decideCustomRole(platform, tier).outcome).toBe("granted");
    expect(decideCustomRole(admin, tier).outcome).toBe("denied");
  });

  it("leaves a shared role to validateCustomRole", () => {
    const shared: CustomRole = {
      shared: true,
      name: "reader",
      grants: [{ permission: "task.read" }],
    };
    expect(decideCustomRole(admin, shared)).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "unsupported" }],
    });
  });

  it("denies malformed input without throwing", () => {
    for (const input of [
      null,
      "planner",
      { name: 3, tenant: "acme" },
      { name: "planner" },
      { name: "planner", tenant: "acme", grants: "task.read" },
    ]) {
      // SAFETY: the input is deliberately malformed boundary data.
      const decision = decideCustomRole(admin, input as unknown as CustomRole);
      expect(decision).toMatchObject({
        outcome: "denied",
        denials: [{ reason: "validation" }],
      });
    }
  });

  it("denies the anonymous subject and a snapshot instance", () => {
    const anonymous = getPermDockSync(policy, null);
    expect(
      decideCustomRole(anonymous, planner([{ permission: "task.read" }])),
    ).toMatchObject({ outcome: "denied", denials: [{ reason: "anonymous" }] });
    const client = fromSnapshot(admin.snapshot());
    expect(
      decideCustomRole(client, planner([{ permission: "task.read" }])),
    ).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "unsupported" }],
    });
  });
});
