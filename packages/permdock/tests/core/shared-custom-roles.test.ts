import { describe, expect, it } from "vitest";

import type {
  CustomRole,
  Membership,
  Subject,
} from "../../src/core/subject.ts";

import { customRoleSource } from "../../src/core/custom-role-source.ts";
import {
  customRoleClaim,
  membershipsClaim,
  resolveCustomRole,
  validateCustomRole,
} from "../../src/core/custom-roles.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { memoryCustomRoleSource } from "../../src/core/memory-sources.ts";
import { getPermDock, getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";
import { decideRoleChange } from "../../src/index.ts";

const permissions = definePermissions({
  post: resource({ collection: ["read", "update", "create"] }),
  invoice: resource({ collection: ["read", "refund"] }),
  member: resource({ collection: { assignRole: { manageRoles: true } } }),
});

const roles = defineRoles({
  editor: { on: "tenant", assignable: true },
  billing: { on: "tenant", assignable: true },
  owner: { on: "tenant", assignable: false },
  steward: { on: "tenant", assignable: true },
});

const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { tenant: { key: "orgId" } },
    subject: () => null,
    roles: [
      role(roles.editor, [
        allow(permissions.post.read),
        allow(permissions.post.update),
        allow(permissions.post.create),
      ]),
      role(roles.billing, [
        allow(permissions.invoice.read),
        allow(permissions.invoice.refund),
      ]),
      role(roles.owner, [allow(permissions.member.assignRole)]),
      role(roles.steward, [allow(permissions.member.assignRole)]),
    ],
  },
);

const viewer: CustomRole = {
  shared: true,
  name: "viewer",
  grants: [{ permission: "post.read" }, { permission: "invoice.read" }],
  meta: { title: "Viewer" },
};

const tenantViewer: CustomRole = {
  tenant: "acme",
  name: "viewer",
  grants: [{ permission: "post.update" }],
};

const reader: CustomRole = {
  tenant: "acme",
  name: "reader",
  grants: [{ permission: "post.read" }],
};

function memberOf(
  ...entries: readonly (readonly [string, readonly string[]])[]
): Subject {
  const memberships: Membership[] = entries.map(([tenant, held]) => ({
    tenant,
    roles: held,
  }));
  return { principal: { id: "u1", memberships }, context: {} };
}

describe("shared custom roles", () => {
  it("resolve against the ceiling of their scope", () => {
    expect(validateCustomRole(policy, viewer)).toEqual({
      ok: true,
      permissions: ["invoice.read", "post.read"],
      dropped: [],
      renamed: [],
    });
    const grants = resolveCustomRole(policy, viewer).grants;
    expect(grants.every((grant) => grant.scope === "tenant")).toBe(true);
    expect(
      validateCustomRole(policy, {
        shared: true,
        name: "assigner",
        grants: [{ permission: "member.assignRole" }],
      }).dropped,
    ).toEqual([]);
  });

  it("grant through a membership in any tenant", () => {
    const customRoles = memoryCustomRoleSource([viewer]);
    for (const tenant of ["acme", "globex"]) {
      const permdock = getPermDockSync(policy, memberOf([tenant, ["viewer"]]), {
        tenant,
        customRoles,
      });
      expect(permdock.can(permissions.post.read)).toBe(true);
      expect(permdock.can(permissions.invoice.read)).toBe(true);
      expect(permdock.can(permissions.post.update)).toBe(false);
    }
    const none = getPermDockSync(policy, memberOf(["acme", []]), {
      tenant: "acme",
      customRoles,
    });
    expect(none.can(permissions.post.read)).toBe(false);
    const viaPrincipalRoles = getPermDockSync(
      policy,
      { principal: { id: "u1", roles: ["viewer"] }, context: {} },
      { customRoles },
    );
    expect(viaPrincipalRoles.can(permissions.post.read)).toBe(false);
  });

  it("shadow a tenant custom role of the same name", () => {
    const permdock = getPermDockSync(policy, memberOf(["acme", ["viewer"]]), {
      tenant: "acme",
      customRoles: memoryCustomRoleSource([viewer, tenantViewer]),
    });
    expect(permdock.can(permissions.post.read)).toBe(true);
    expect(permdock.can(permissions.post.update)).toBe(false);
    expect(
      validateCustomRole(policy, tenantViewer, { shared: [viewer] }),
    ).toEqual({
      ok: false,
      permissions: [],
      dropped: [{ role: "viewer", reason: "name-taken" }],
      renamed: [],
    });
    expect(validateCustomRole(policy, reader, { shared: [viewer] }).ok).toBe(
      true,
    );
  });

  it("ignore a shared role with a tenant, team, id or the global scope", () => {
    const forged: unknown[] = [
      { ...viewer, tenant: "acme" },
      { ...viewer, team: "t1" },
      { ...viewer, id: "acme" },
      { ...viewer, scope: "global" },
    ];
    for (const shape of forged) {
      const permdock = getPermDockSync(policy, memberOf(["acme", ["viewer"]]), {
        tenant: "acme",
        customRoles: {
          rolesFor: () => [],
          // SAFETY: deliberately malformed input to check the runtime guard.
          sharedRoles: () => [shape as CustomRole],
        },
      });
      expect(permdock.can(permissions.post.read)).toBe(false);
    }
  });

  it("read only shared: true roles from sharedRoles, once, and deny when it throws", async () => {
    let calls = 0;
    const permdock = getPermDockSync(
      policy,
      memberOf(["acme", ["reader"]], ["globex", ["viewer"]]),
      {
        tenant: "acme",
        customRoles: {
          rolesFor: () => [],
          sharedRoles: (context) => {
            calls += 1;
            expect(context?.held.toSorted()).toEqual(["reader", "viewer"]);
            return [reader, viewer];
          },
        },
      },
    );
    expect(calls).toBe(1);
    expect(permdock.can(permissions.post.read)).toBe(false);
    const auth: unknown[] = [];
    const throwing = getPermDockSync(policy, memberOf(["acme", ["viewer"]]), {
      tenant: "acme",
      customRoles: {
        name: "roles-table",
        rolesFor: () => [],
        sharedRoles: () => {
          throw new Error("down");
        },
      },
    });
    throwing.on("auth", (event) => {
      auth.push(event);
    });
    expect(throwing.can(permissions.post.read)).toBe(false);
    expect(auth).toEqual([
      { reason: "source-threw", source: "customRoles", name: "roles-table" },
    ]);
    const async = await getPermDock(policy, memberOf(["acme", ["viewer"]]), {
      tenant: "acme",
      customRoles: {
        rolesFor: () => [],
        sharedRoles: () => Promise.resolve([viewer]),
      },
    });
    expect(async.can(permissions.post.read)).toBe(true);
  });

  it("are not read for a subject without a tenant membership", () => {
    let calls = 0;
    const read = {
      rolesFor: () => [],
      sharedRoles: () => {
        calls += 1;
        return [viewer];
      },
    };
    getPermDockSync(policy, null, { customRoles: read });
    getPermDockSync(
      policy,
      { principal: { id: "u1" }, context: {} },
      { customRoles: read },
    );
    expect(calls).toBe(0);
  });

  it("pass through customRoleSource, skipped with read: 'held' when only declared roles are held", () => {
    let calls = 0;
    const sharedReader = {
      rolesFor: () => [],
      sharedRoles: () => {
        calls += 1;
        return [viewer];
      },
    };
    const held = customRoleSource(sharedReader, { read: "held", policy });
    getPermDockSync(policy, memberOf(["acme", ["editor"]]), {
      tenant: "acme",
      customRoles: held,
    });
    expect(calls).toBe(0);
    const permdock = getPermDockSync(policy, memberOf(["acme", ["viewer"]]), {
      tenant: "acme",
      customRoles: held,
    });
    expect(calls).toBe(1);
    expect(permdock.can(permissions.post.read)).toBe(true);
  });

  it("are offered in every tenant, marked shared, before tenant roles", () => {
    const steward = getPermDockSync(
      policy,
      memberOf(["acme", ["steward"]], ["globex", ["steward"]]),
      {
        tenant: "acme",
        customRoles: memoryCustomRoleSource([viewer, reader]),
      },
    );
    const offered = steward.assignableRoles();
    expect(offered.map((leaf) => leaf.key)).toEqual([
      "editor",
      "billing",
      "steward",
      "viewer",
      "reader",
    ]);
    expect(offered.find((leaf) => leaf.key === "viewer")).toMatchObject({
      on: "tenant",
      assignable: true,
      shared: true,
      meta: { title: "Viewer" },
    });
    expect(offered.find((leaf) => leaf.key === "reader")?.shared).toBe(
      undefined,
    );
    expect(
      steward.assignableRoles({ tenant: "globex" }).map((leaf) => leaf.key),
    ).toContain("viewer");
  });

  it("are assigned with the same rules as a tenant role", () => {
    const customRoles = memoryCustomRoleSource([viewer]);
    const assign = (id: string) => ({
      kind: "assign" as const,
      role: "viewer",
      scope: "tenant",
      id,
      target: { id: "u2", roles: [] },
    });
    const steward = getPermDockSync(
      policy,
      memberOf(["acme", ["steward"]], ["globex", ["steward"]]),
      { tenant: "acme", customRoles },
    );
    expect(decideRoleChange(steward, assign("acme")).outcome).toBe("granted");
    expect(decideRoleChange(steward, assign("globex")).outcome).toBe("granted");
    const editor = getPermDockSync(policy, memberOf(["acme", ["editor"]]), {
      tenant: "acme",
      customRoles,
    });
    expect(decideRoleChange(editor, assign("acme"))).toMatchObject({
      outcome: "denied",
      denials: [{ role: "viewer", reason: "not-assignable-by" }],
    });
  });

  it("reach the snapshot and the client", () => {
    const snapshot = snapshotFor(policy, memberOf(["acme", ["viewer"]]), {
      tenant: "acme",
      customRoles: [viewer, tenantViewer],
    });
    const client = fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(client.can(permissions.post.read)).toBe(true);
    expect(client.can(permissions.post.update)).toBe(false);
  });

  it("ride the membership in the jwt claim", () => {
    const claim = membershipsClaim(
      [
        { tenant: "acme", roles: ["viewer"] },
        { tenant: "globex", roles: ["editor"] },
      ],
      [viewer, tenantViewer],
      scopeList(policy.scopes),
    );
    expect(claim[0]).toMatchObject({
      grants: { viewer: ["post.read", "invoice.read"] },
    });
    expect(claim[1]).not.toHaveProperty("grants");
    expect(customRoleClaim([viewer])).toEqual({
      viewer: ["post.read", "invoice.read"],
    });
  });
});
