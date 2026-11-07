import { describe, expect, it } from "vitest";

import { getPermDockSync } from "../../src/core/permdock.ts";
import { permissions, policy } from "../fixtures/saas.ts";

const user = {
  id: "u1",
  memberships: [
    { scope: "tenant", id: "t1", roles: ["viewer", "member", "admin"] },
  ],
};

describe("where() over several roles", () => {
  it("emits one tenant equality for roles that grant the same rows", () => {
    const { condition } = getPermDockSync(policy, user, { tenant: "t1" }).where(
      permissions.project.read,
    );
    expect(JSON.stringify(condition).split('"value":"t1"')).toHaveLength(2);
  });

  it("agrees with the rows can() grants", () => {
    const permdock = getPermDockSync(policy, user, { tenant: "t1" });
    for (const orgId of ["t1", "t2"]) {
      const row = { id: "p", orgId, ownerId: "x", archived: false };
      expect(permdock.can(permissions.project.read, row)).toBe(orgId === "t1");
    }
  });
});
