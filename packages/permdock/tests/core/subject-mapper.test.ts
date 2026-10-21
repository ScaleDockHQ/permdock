import { describe, expect, it } from "vitest";

import {
  allow,
  getPermDockSync,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  report: resource({ actions: ["read"], collection: ["list"] }),
});

type AppUser = {
  readonly id: string;
  readonly roles: readonly string[];
  readonly verified: boolean;
};

const policy = definePolicy(permissions, {
  roles: [role("admin", [allow(permissions.report.list)])],
  // Narrows: an unverified user holds no role, whatever the session says.
  subject: (user: AppUser | null) =>
    user === null
      ? null
      : { id: user.id, roles: user.verified ? user.roles : [] },
});

describe("the policy's subject mapper", () => {
  it("maps a user that looks like a principal instead of passing it through", async () => {
    const permdock = getPermDockSync(policy, {
      id: "u1",
      roles: ["admin"],
      verified: false,
    });
    expect(permdock.subject.principal?.roles).toStrictEqual([]);
    expect(permdock.can(permissions.report.list)).toBe(false);
  });

  it("still takes a resolved Subject as is", async () => {
    const permdock = getPermDockSync(policy, {
      principal: { id: "u1", roles: ["admin"] },
      context: {},
    });
    expect(permdock.can(permissions.report.list)).toBe(true);
  });
});
