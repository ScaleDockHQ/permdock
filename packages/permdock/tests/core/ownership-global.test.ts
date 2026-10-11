import { describe, expect, it } from "vitest";

import type { RoleChange } from "../../src/core/ownership.ts";
import type { Principal } from "../../src/core/subject.ts";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { type PermDock, createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";

const permissions = definePermissions({
  ticket: resource({ actions: ["read", "write"] }),
  report: resource({
    actions: ["read"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { organization: { key: "organization_id" } },
  subject: (user: Principal | null) => user,
  roles: [
    role(
      "platform-admin",
      [allow(permissions.ticket.read), allow(permissions.ticket.write)],
      { assignable: true },
    ),
    role("support", [allow(permissions.ticket.read)], { assignable: true }),
    role("auditor", [allow(permissions.ticket.read)], { assignable: true }),
    role("superuser", [allow(permissions.report.read)]),
    role("exclusive", [allow(permissions.ticket.read)], {
      assignable: true,
      exclusiveWith: ["support"],
    }),
    role("member", [allow(permissions.report.read)], { on: "organization" }),
  ],
});

async function actor(roles: readonly string[]): Promise<PermDock> {
  return createPermDock(policy, { id: "u_actor", roles }, {});
}

const target: { id: string; roles: string[] } = {
  id: "u_target",
  roles: [],
};

function reasons(decision: ReturnType<PermDock["decideRoleChange"]>) {
  return decision.outcome === "denied"
    ? decision.denials.map((denial) => denial.reason)
    : [];
}

describe("decideRoleChange: global roles", () => {
  it("lets a platform admin assign and revoke a global role it can assign", async () => {
    const admin = await actor(["platform-admin"]);
    const assign: RoleChange = {
      kind: "assign",
      role: "support",
      scope: "global",
      target,
    };
    expect(admin.decideRoleChange(assign).outcome).toBe("granted");
    expect(
      admin.decideRoleChange({
        kind: "revoke",
        role: "support",
        scope: "global",
        target: { ...target, roles: ["support"] },
      }).outcome,
    ).toBe("granted");
  });

  it("lists the global roles the actor may assign", async () => {
    const admin = await actor(["platform-admin"]);
    expect(
      admin.assignableRoles({ scope: "global" }).map((leaf) => leaf.key),
    ).toEqual(["platform-admin", "support", "auditor", "exclusive"]);
    const support = await actor(["support"]);
    expect(
      support.assignableRoles({ scope: "global" }).map((leaf) => leaf.key),
    ).toEqual(["support", "auditor", "exclusive"]);
    expect((await actor([])).assignableRoles({ scope: "global" })).toEqual([]);
  });

  it("refuses a lower global role that assigns or revokes a higher one", async () => {
    const support = await actor(["support"]);
    for (const kind of ["assign", "revoke"] as const) {
      const decision = support.decideRoleChange({
        kind,
        role: "platform-admin",
        scope: "global",
        target: {
          ...target,
          roles: kind === "revoke" ? ["platform-admin"] : [],
        },
      });
      expect(reasons(decision)).toEqual(["not-assignable-by"]);
    }
  });

  it("refuses a change to the actor's own roles", async () => {
    const admin = await actor(["platform-admin"]);
    expect(
      reasons(
        admin.decideRoleChange({
          kind: "revoke",
          role: "platform-admin",
          scope: "global",
          target: { id: "u_actor", roles: ["platform-admin"] },
        }),
      ),
    ).toContain("self-demotion");
    expect(
      reasons(
        admin.decideRoleChange({
          kind: "assign",
          role: "support",
          scope: "global",
          target: { id: "u_actor", roles: [] },
        }),
      ),
    ).toContain("not-assignable-by");
  });

  it("applies exclusiveWith and externally managed targets", async () => {
    const admin = await actor(["platform-admin"]);
    expect(
      reasons(
        admin.decideRoleChange({
          kind: "assign",
          role: "exclusive",
          scope: "global",
          target: { ...target, roles: ["support"] },
        }),
      ),
    ).toEqual(["conflicting-role"]);
    expect(
      reasons(
        admin.decideRoleChange({
          kind: "assign",
          role: "support",
          scope: "global",
          target: { ...target, managedBy: "idp" },
        }),
      ),
    ).toEqual(["externally-managed"]);
  });

  it("refuses a role that is not assignable or not global", async () => {
    const admin = await actor(["platform-admin"]);
    expect(
      reasons(
        admin.decideRoleChange({
          kind: "assign",
          role: "superuser",
          scope: "global",
          target,
        }),
      ),
    ).toEqual(["not-assignable-by"]);
    expect(
      reasons(
        admin.decideRoleChange({
          kind: "assign",
          role: "member",
          scope: "global",
          target,
        }),
      ),
    ).toEqual(["scope"]);
    expect(
      reasons(
        admin.decideRoleChange({
          kind: "assign",
          role: "ghost",
          scope: "global",
          target,
        }),
      ),
    ).toEqual(["unknown-role"]);
  });

  it("refuses a global role at a named scope and an id on a global change", async () => {
    const admin = await actor(["platform-admin"]);
    expect(
      reasons(
        admin.decideRoleChange({
          kind: "assign",
          role: "support",
          scope: "organization",
          id: "acme",
          target,
        }),
      ),
    ).toEqual(["scope"]);
    const withId = {
      kind: "assign",
      role: "support",
      scope: "global",
      id: "acme",
      target,
    };
    expect(
      // @ts-expect-error a global change carries no id
      reasons(admin.decideRoleChange(withId)),
    ).toEqual(["validation"]);
  });

  it("denies an anonymous actor", async () => {
    const anonymous = await createPermDock(policy, null, {});
    expect(
      reasons(
        anonymous.decideRoleChange({
          kind: "assign",
          role: "support",
          scope: "global",
          target,
        }),
      ),
    ).toEqual(["anonymous"]);
  });

  it("transfers only a role the actor holds globally", async () => {
    const support = await actor(["support"]);
    expect(
      support.decideRoleChange({
        kind: "transfer",
        role: "support",
        scope: "global",
        target,
      }).outcome,
    ).toBe("granted");
    expect(
      reasons(
        support.decideRoleChange({
          kind: "transfer",
          role: "auditor",
          scope: "global",
          target,
        }),
      ),
    ).toEqual(["not-assignable-by"]);
  });
});

describe("decideRoleChange: global roles with an assigns graph", () => {
  const graph = definePolicy(permissions, {
    scopes: { organization: { key: "organization_id" } },
    subject: (user: Principal | null) => user,
    roles: [
      role("root", [allow(permissions.ticket.read)], {
        assignable: true,
        assigns: ["agent"],
      }),
      role("agent", [allow(permissions.ticket.read)], { assignable: true }),
      role("other", [allow(permissions.ticket.read)], { assignable: true }),
      role("member", [allow(permissions.report.read)], { on: "organization" }),
    ],
  });
  const change = (kind: "assign" | "revoke", name: string): RoleChange => ({
    kind,
    role: name,
    scope: "global",
    target: { id: "u_target", roles: kind === "revoke" ? [name] : [] },
  });

  it("hands out exactly the roles the held global roles list", async () => {
    const root = await createPermDock(
      graph,
      { id: "u_actor", roles: ["root"] },
      {},
    );
    expect(root.decideRoleChange(change("assign", "agent"))).toMatchObject({
      outcome: "granted",
      role: "root",
    });
    expect(reasons(root.decideRoleChange(change("revoke", "other")))).toEqual([
      "not-assignable-by",
    ]);
    expect(root.assignableRoles({ scope: "global" }).map((r) => r.key)).toEqual(
      ["agent"],
    );
  });

  it("answers no global roles on a snapshot", async () => {
    const root = await createPermDock(
      graph,
      { id: "u_actor", roles: ["root"] },
      {},
    );
    const snapshot = root.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error("expected JSON snapshot");
    }
    expect(
      fromSnapshot(JSON.parse(JSON.stringify(snapshot))).assignableRoles({
        scope: "global",
      }),
    ).toEqual([]);
  });
});
