import { describe, expect, it } from "vitest";

import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  getPermDockSync,
  isRoleName,
  resource,
  role,
} from "../../src/index.ts";
import { policy as vocabularyPolicy } from "../fixtures/vocabulary.ts";

const permissions = definePermissions({
  workspace: resource({
    actions: ["read", "update", "delete"],
    collection: ["create"],
  }),
  member: resource({ actions: ["read", "remove"], collection: ["invite"] }),
  billing: resource({ actions: ["read", "update"] }),
});

const policy = definePolicy(permissions, {
  roles: [
    role("owner", [allow(permissions)]),
    role("admin", [
      allow([permissions.workspace, permissions.member]),
      deny(permissions.billing.update),
    ]),
    role("viewer", [allow(permissions.workspace.read)]),
  ],
  subject: (user: { readonly id: string; readonly role: string }) => ({
    id: user.id,
    roles: [user.role],
  }),
});

describe(isRoleName, () => {
  it("accepts a declared role and rejects anything else", () => {
    expect(isRoleName(vocabularyPolicy, "editor")).toBe(true);
    expect(isRoleName(vocabularyPolicy, "owner")).toBe(false);
    expect(isRoleName(vocabularyPolicy, "")).toBe(false);
    expect(isRoleName(vocabularyPolicy, 1)).toBe(false);
    expect(isRoleName(vocabularyPolicy, null)).toBe(false);
  });

  it("knows roles declared by name, without a role vocabulary", () => {
    expect(isRoleName(policy, "admin")).toBe(true);
    expect(isRoleName(policy, "superuser")).toBe(false);
  });

  it("matches evaluation: a name it rejects grants nothing", () => {
    const permdock = getPermDockSync(policy, { id: "u1", role: "superuser" });
    expect(permdock.can(permissions.workspace.create)).toBe(false);
    expect(permdock.decide(permissions.workspace.create).outcome).toBe(
      "denied",
    );
  });
});

describe("allow on a resource or the whole tree", () => {
  it("grants every action of the whole tree", () => {
    const owner = getPermDockSync(policy, { id: "u1", role: "owner" });
    expect(
      owner.canAll([
        permissions.workspace.create,
        permissions.member.invite,
        [permissions.billing.update, {}],
        [permissions.member.remove, {}],
      ]),
    ).toBe(true);
  });

  it("grants every action of the listed resources only", () => {
    const admin = getPermDockSync(policy, { id: "u2", role: "admin" });
    expect(
      admin.canAll([
        permissions.workspace.create,
        [permissions.workspace.delete, {}],
        permissions.member.invite,
      ]),
    ).toBe(true);
    expect(admin.can(permissions.billing.read, {})).toBe(false);
  });

  it("lists one grant per action", () => {
    const owner = policy.rolesByName.get("owner");
    expect(
      owner?.grants.map((grant) => grant.permission.key).toSorted(),
    ).toStrictEqual([
      "billing.read",
      "billing.update",
      "member.invite",
      "member.read",
      "member.remove",
      "workspace.create",
      "workspace.delete",
      "workspace.read",
      "workspace.update",
    ]);
  });
});
