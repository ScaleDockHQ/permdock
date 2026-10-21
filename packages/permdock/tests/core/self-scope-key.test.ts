import { describe, expect, it } from "vitest";

import { fromSnapshot, getPermDockSync } from "../../src/core/permdock.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

/**
 * Both tables are scope instances themselves: each row's own `id` is the scope
 * id.
 */
const permissions = definePermissions({
  organization: resource({
    id: "id",
    actions: ["read"],
    relations: { self: { field: "id", memberOf: "organization" } },
  }),
  team: resource({
    id: "id",
    actions: ["read"],
    relations: { self: { field: "id", memberOf: "team" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: {
    organization: { key: "organization_id" },
    team: { key: "team_id", within: "organization" },
  },
  roles: [
    role("admin", [allow(permissions.organization.read)], {
      on: "organization",
    }),
    role("lead", [allow(permissions.team.read)], { on: "team" }),
  ],
  subject: () => null,
});

const subject = {
  principal: {
    id: "u1",
    tenant: "T",
    memberships: [
      { scope: "organization", id: "T", roles: ["admin"] },
      {
        scope: "team",
        id: "t1",
        within: { organization: "T" },
        roles: ["lead"],
      },
    ],
  },
  context: {},
};

describe("relations.self with a scope key and no other relation", () => {
  const permdock = getPermDockSync(policy, subject);
  const snapshot = permdock.snapshot();
  if (snapshot instanceof Promise) {
    throw new TypeError("expected an unsigned snapshot");
  }
  const local = fromSnapshot(snapshot);

  it.each([
    ["live", permdock],
    ["snapshot", local],
  ] as const)("decides on the row's own id (%s)", (_name, instance) => {
    expect(instance.can(permissions.organization.read, { id: "T" })).toBe(true);
    expect(instance.can(permissions.organization.read, { id: "X" })).toBe(
      false,
    );
    expect(instance.can(permissions.team.read, { id: "t1" })).toBe(true);
    expect(instance.can(permissions.team.read, { id: "t2" })).toBe(false);
  });

  it("filters the same rows through where()", () => {
    expect(permdock.where(permissions.team.read).condition).toEqual({
      op: "eq",
      field: "id",
      value: "t1",
    });
  });
});
