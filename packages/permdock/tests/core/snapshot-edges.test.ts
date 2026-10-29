import { describe, expect, it } from "vitest";

import { allow } from "../../src/core/grant-builders.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { policy, tree } from "../fixtures/org-tree.ts";

describe("snapshot edges", () => {
  it("snapshots tenant, team and resource grants and an anonymous subject", async () => {
    const scopedSnap = getPermDockSync(
      definePolicy(tree, {
        roles: [role("viewer", [allow(tree.post.read)], { on: "tenant" })],
        scopes: { tenant: { key: "orgId" } },
        subject: () => ({
          id: "u1",
          memberships: [{ scope: "tenant", id: "o1", roles: ["viewer"] }],
        }),
      }),
      { id: "u1" },
      { tenant: "o1" },
    );
    const snap = scopedSnap.snapshot({
      include: [tree.post.read],
      tenants: "all",
    });
    if (snap instanceof Promise) {
      throw new TypeError("json");
    }
    expect(snap.grants.some((grant) => grant.scope === "tenant")).toBe(true);
    const anonymousSnap = getPermDockSync(policy, null).snapshot();
    if (anonymousSnap instanceof Promise) {
      throw new TypeError("json");
    }
    expect(anonymousSnap.subject.principal).toBeNull();
    expect(
      scopedSnap.filter(tree.post.read, [
        { id: "p1", orgId: "o9", authorId: "u1" },
      ]),
    ).toStrictEqual([]);
    const teamPolicy = definePolicy(tree, {
      roles: [role("lead", [allow(tree.post.read)], { on: "team" })],
      scopes: {
        tenant: { key: "orgId" },
        team: { key: "teamId", within: "tenant" },
      },
      subject: () => ({
        id: "u1",
        memberships: [
          {
            within: { tenant: "o1" },
            scope: "team",
            id: "t1",
            roles: ["lead"],
          },
        ],
      }),
    });
    const teamPermdock = getPermDockSync(
      teamPolicy,
      { id: "u1" },
      { tenant: "o1" },
    );
    const teamSnap = teamPermdock.snapshot();
    if (teamSnap instanceof Promise) {
      throw new TypeError("json");
    }
    expect(teamSnap.grants.some((grant) => grant.scope === "team")).toBe(true);
    expect(teamPermdock.snapshot({ include: [] })).toBeDefined();
    const resourceSnap = getPermDockSync(
      definePolicy(tree, {
        roles: [role("owner", [allow(tree.post.read)], { on: tree.post })],
        subject: () => ({
          id: "u1",
          memberships: [
            { on: { resource: "post", id: "p1" }, roles: ["owner"] },
          ],
        }),
      }),
      { id: "u1" },
    );
    const owned = resourceSnap.snapshot();
    if (owned instanceof Promise) {
      throw new TypeError("json");
    }
    expect(owned.grants.some((grant) => typeof grant.scope === "object")).toBe(
      true,
    );
  });
});
