import { describe, expect, it } from "vitest";

import type { MembershipSource } from "../../src/core/interfaces.ts";

import { countHolders, createPermDock } from "../../src/index.ts";
import { policy } from "../fixtures/named-scopes.ts";

const source: MembershipSource = {
  membershipsFor: () => [],
  list: ({ scope, id }) =>
    scope === "organization" && id === "T"
      ? [
          {
            principal: { id: "u1" },
            membership: { scope, id, roles: ["owner"], via: "staff" },
          },
          {
            principal: { id: "u1" },
            membership: { scope, id, roles: ["owner", "admin"], via: "staff" },
          },
          {
            principal: { id: "u2" },
            membership: { scope, id, roles: ["owner"], expiresAt: 1 },
          },
          {
            principal: { id: "u3" },
            membership: { scope, id, roles: ["admin"] },
          },
        ]
      : [],
};

describe("countHolders", () => {
  it("counts each live holder once and feeds decideRoleChange", async () => {
    expect(
      await countHolders(source, {
        scope: "organization",
        id: "T",
        role: "owner",
      }),
    ).toBe(1);
    expect(
      await countHolders([source], {
        scope: "organization",
        id: "T",
        role: { key: "admin" },
      }),
    ).toBe(2);
    const holders = await countHolders(source, {
      scope: "organization",
      id: "T",
      role: "owner",
    });
    const permdock = await createPermDock(policy, {
      principal: {
        id: "u1",
        memberships: [
          { scope: "organization", id: "T", roles: ["owner"], via: "staff" },
        ],
      },
      context: {},
    });
    expect(
      permdock.decideRoleChange({
        kind: "revoke",
        role: "owner",
        scope: "organization",
        id: "T",
        target: { id: "u9", via: "staff", roles: ["owner"] },
        ...(holders === undefined ? {} : { holders }),
      }),
    ).toMatchObject({
      outcome: "denied",
      denials: expect.arrayContaining([
        expect.objectContaining({ reason: "last-holder" }),
      ]),
    });
  });

  it("answers undefined for a source that cannot list or fails", async () => {
    expect(
      await countHolders(
        { membershipsFor: () => [] },
        { scope: "organization", id: "T", role: "owner" },
      ),
    ).toBeUndefined();
    expect(
      await countHolders(
        {
          membershipsFor: () => [],
          list: () => Promise.reject(new Error("down")),
        },
        { scope: "organization", id: "T", role: "owner" },
      ),
    ).toBeUndefined();
  });
});
