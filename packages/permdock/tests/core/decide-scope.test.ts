import { describe, expect, it } from "vitest";

import type { DecideOptions, PermDock } from "../../src/core/permdock.ts";
import type { Principal } from "../../src/core/subject.ts";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { reasonOf } from "../fixtures/decisions.ts";

const permissions = definePermissions({
  ticket: resource({
    id: "id",
    actions: ["read"],
    collection: ["create", "list"],
    relations: {
      workspace: { field: "workspace_id", memberOf: "workspace" },
      project: { field: "project_id", memberOf: "project" },
    },
  }),
});

const policy = definePolicy(permissions, {
  scopes: {
    workspace: { key: "workspace_id" },
    project: { key: "project_id", within: "workspace" },
  },
  subject: (user: Principal) => user,
  roles: [
    role(
      "member",
      [allow([permissions.ticket.create, permissions.ticket.list])],
      { on: "workspace" },
    ),
    role("reporter", [allow(permissions.ticket.create)], { on: "project" }),
    role("watcher", [allow(permissions.ticket.list)], {
      on: permissions.ticket,
    }),
    role("support", [allow(permissions.ticket.list)]),
  ],
});

const users = {
  member: {
    id: "u_member",
    tenant: "W",
    memberships: [{ scope: "workspace", id: "W", roles: ["member"] }],
  },
  reporter: {
    id: "u_reporter",
    tenant: "W",
    memberships: [
      {
        scope: "project",
        id: "P",
        within: { workspace: "W" },
        roles: ["reporter"],
      },
    ],
  },
  watcher: {
    id: "u_watcher",
    tenant: "W",
    memberships: [{ on: { resource: "ticket", id: "t1" }, roles: ["watcher"] }],
  },
  support: { id: "u_support", roles: ["support"] },
} satisfies Record<string, Principal>;

async function both(user: Principal): Promise<readonly PermDock[]> {
  const server = await createPermDock(policy, user);
  const client = fromSnapshot(parseSnapshot(JSON.stringify(server.snapshot())));
  return [server, client];
}

const rowInP = { workspace_id: "W", project_id: "P" };

describe("decide option scope", () => {
  it("keeps a nested membership answering a rowless collection check by default", async () => {
    for (const permdock of await both(users.reporter)) {
      expect(permdock.can(permissions.ticket.create)).toBe(true);
      expect(
        permdock.can(permissions.ticket.create, undefined, {
          scope: "project",
        }),
      ).toBe(true);
    }
  });

  it("answers from memberships of the named scope only", async () => {
    const workspace: DecideOptions = { scope: "workspace" };
    for (const permdock of await both(users.reporter)) {
      const decision = permdock.decide(
        permissions.ticket.create,
        undefined,
        workspace,
      );
      expect(decision.outcome).toBe("denied");
      expect(reasonOf(decision)).toBe("scope");
      expect(
        permdock.can(permissions.ticket.create, rowInP, {
          ...workspace,
          trusted: true,
        }),
      ).toBe(false);
    }
    for (const permdock of await both(users.member)) {
      expect(
        permdock.can(permissions.ticket.create, undefined, workspace),
      ).toBe(true);
      expect(
        permdock.can(permissions.ticket.create, undefined, {
          scope: "project",
        }),
      ).toBe(false);
    }
  });

  it("keeps global roles and drops resource roles", async () => {
    for (const permdock of await both(users.support)) {
      expect(
        permdock.can(permissions.ticket.list, undefined, {
          scope: "workspace",
        }),
      ).toBe(true);
    }
    const watcher = await createPermDock(policy, users.watcher);
    expect(watcher.can(permissions.ticket.list, { id: "t1" })).toBe(true);
    expect(
      watcher.can(
        permissions.ticket.list,
        { id: "t1" },
        { scope: "workspace", trusted: true },
      ),
    ).toBe(false);
  });

  it("denies every membership grant for a scope the policy does not declare", async () => {
    for (const permdock of await both(users.member)) {
      expect(
        permdock.can(permissions.ticket.create, undefined, { scope: "team" }),
      ).toBe(false);
    }
  });
});
