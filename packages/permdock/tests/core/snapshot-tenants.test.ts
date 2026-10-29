import { describe, expect, it } from "vitest";

import type { Snapshot } from "../../src/core/snapshot-types.ts";
import type { Subject } from "../../src/core/subject.ts";

import { allow } from "../../src/core/grant-builders.ts";
import { subjectMembershipSource } from "../../src/core/memory-sources.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { tree } from "../fixtures/org-tree.ts";

const memberships = [
  { scope: "tenant", id: "o1", roles: ["viewer"] },
  { scope: "tenant", id: "o2", roles: ["viewer"] },
  { scope: "tenant", id: "o3", roles: ["viewer"] },
];

const policy = definePolicy(tree, {
  roles: [role("viewer", [allow(tree.post.read)], { on: "tenant" })],
  scopes: { tenant: { key: "orgId" } },
  subject: () => ({ id: "u1", memberships }),
});

const subject: Subject = {
  principal: { id: "u1", tenant: "o1", memberships },
  context: {},
};

function snapshotOf(tenants?: "all" | readonly string[]): Snapshot {
  const instance = getPermDockSync(policy, { id: "u1" }, { tenant: "o1" });
  const snapshot = instance.snapshot({
    include: [tree.post.read],
    ...(tenants === undefined ? {} : { tenants }),
  });
  if (snapshot instanceof Promise) {
    throw new TypeError("snapshot must be synchronous");
  }
  return snapshot;
}

describe("snapshot tenants option", () => {
  it("lists the active tenant by default", () => {
    expect(snapshotOf().tenants).toStrictEqual(["o1"]);
  });

  it("lists every membership tenant for 'all'", () => {
    expect(snapshotOf("all").tenants).toStrictEqual(["o1", "o2", "o3"]);
  });

  it("lists only the named tenants the subject belongs to", () => {
    expect(snapshotOf(["o2", "o3"]).tenants).toStrictEqual(["o2", "o3"]);
  });

  it("drops a named tenant without a membership", () => {
    expect(snapshotOf(["o2", "o9"]).tenants).toStrictEqual(["o2"]);
    expect(snapshotOf([]).tenants).toStrictEqual([]);
  });
});

describe(subjectMembershipSource, () => {
  it("answers the subject's own memberships", async () => {
    const source = subjectMembershipSource(subject);
    expect(await source.membershipsFor({ id: "u1" }, {})).toHaveLength(3);
  });

  it("answers nothing for another principal or an anonymous subject", async () => {
    expect(
      await subjectMembershipSource(subject).membershipsFor({ id: "u2" }, {}),
    ).toStrictEqual([]);
    expect(
      await subjectMembershipSource({
        principal: null,
        context: {},
      }).membershipsFor({ id: "u1" }, {}),
    ).toStrictEqual([]);
  });
});
