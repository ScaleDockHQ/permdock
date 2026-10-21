import { describe, expect, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";
import type { Principal } from "../../src/core/subject.ts";

import { eligiblePreview, stepUpFor } from "../../src/agent/step-up.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { assurance } from "../../src/core/grantee.ts";
import { delegationAllows } from "../../src/core/may-use.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";

const permissions = definePermissions({
  post: resource({
    id: "id",
    actions: ["read", "archive", "delete"],
    relations: { org: { field: "orgId", memberOf: "organization" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { organization: { key: "orgId" } },
  roles: [
    role("member", [allow(permissions.post.read)], { on: "organization" }),
    role("owner", [allow(permissions.post.archive)], { on: "organization" }),
    role("admin", [allow(permissions.post.archive)], {
      on: "organization",
      activation: { maxDuration: 3600 },
    }),
  ],
  grants: [
    allow(permissions.post.delete, {
      to: assurance({ acr: "mfa", maxAge: 300 }),
    }),
  ],
  subject: (user: Principal | null) => user,
});

const row = { id: "p1", orgId: "T" };

const user = (eligible?: readonly string[]): Principal => ({
  id: "u1",
  tenant: "T",
  memberships: [
    {
      scope: "organization",
      id: "T",
      roles: ["member"],
      ...(eligible === undefined ? {} : { eligible }),
    },
  ],
});

function throwing(
  permdock: PermDock,
  method: "simulate" | "snapshot",
): PermDock {
  return {
    ...permdock,
    [method]: () => {
      throw new Error(`no ${method}`);
    },
  };
}

describe(stepUpFor, () => {
  it("skips an eligible role that `activate` refuses for a reason the user cannot fix", () => {
    const permdock = getPermDockSync(policy, user(["owner"]));
    const decision = permdock.decide(permissions.post.archive, row);
    expect(decision.outcome).toBe("denied");
    expect(
      stepUpFor(permdock, permissions.post.archive, row, decision),
    ).toBeUndefined();
  });

  it("answers undefined when deciding the step-up throws", () => {
    const permdock = getPermDockSync(policy, user(["admin"]));
    const decision = permdock.decide(permissions.post.archive, row);
    expect(
      stepUpFor(permdock, permissions.post.archive, row, decision),
    ).toMatchObject({ kind: "activation", role: "admin" });
    expect(
      stepUpFor(
        throwing(permdock, "simulate"),
        permissions.post.archive,
        row,
        decision,
      ),
    ).toBeUndefined();
  });
});

describe(eligiblePreview, () => {
  it("answers undefined for a subject eligible for nothing", () => {
    expect(eligiblePreview(getPermDockSync(policy, user()))).toBeUndefined();
  });

  it("answers undefined when the simulation throws", () => {
    const permdock = getPermDockSync(policy, user(["owner"]));
    expect(eligiblePreview(throwing(permdock, "simulate"))).toBeUndefined();
  });
});

describe(delegationAllows, () => {
  it("answers false when the snapshot throws", () => {
    const permdock = getPermDockSync(policy, user());
    expect(delegationAllows(permdock, permissions.post.delete)).toBe(true);
    expect(
      delegationAllows(throwing(permdock, "snapshot"), permissions.post.delete),
    ).toBe(false);
  });
});
