import { describe, expect, it } from "vitest";

import type { Snapshot } from "../../src/core/snapshot-types.ts";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import { tree } from "../fixtures/org-tree.ts";

const memberships = [
  { scope: "tenant", id: "o1", roles: ["admin"] },
  { scope: "tenant", id: "o2", roles: ["admin"] },
];

const policy = definePolicy(tree, {
  roles: [
    role("viewer", [allow(tree.post.read)], { on: "tenant" }),
    role("admin", [allow(tree.post.read), allow(tree.post.update)], {
      on: "tenant",
    }),
  ],
  scopes: { tenant: { key: "orgId" } },
  subject: () => ({ id: "u1", memberships }),
});

function snapshotOf(omitAssignable?: boolean): Snapshot {
  const instance = getPermDockSync(policy, { id: "u1" }, { tenant: "o1" });
  const snapshot = instance.snapshot({
    tenants: "all",
    ...(omitAssignable === undefined ? {} : { omitAssignable }),
  });
  if (snapshot instanceof Promise) {
    throw new TypeError("snapshot must be synchronous");
  }
  return snapshot;
}

describe("snapshot omitAssignable option", () => {
  it("carries assignable per tenant by default", () => {
    expect(snapshotOf().assignable?.map((entry) => entry.tenant)).toStrictEqual(
      ["o1", "o2"],
    );
  });

  it("leaves assignable out and keeps the grants", () => {
    const full = snapshotOf();
    const lean = snapshotOf(true);

    expect(lean.assignable).toBeUndefined();
    expect(lean.grants).toStrictEqual(full.grants);
    expect(lean.tenants).toStrictEqual(["o1", "o2"]);
  });

  it("still decides checks from a snapshot without assignable", () => {
    const full = fromSnapshot(snapshotOf());
    const lean = fromSnapshot(snapshotOf(true));
    const row = { id: "p1", orgId: "o1" };

    expect(full.can(tree.post.update, row)).toBe(true);
    expect(lean.can(tree.post.update, row)).toBe(true);
    expect(full.assignableRoles({ tenant: "o1" })).not.toStrictEqual([]);
    expect(lean.assignableRoles({ tenant: "o1" })).toStrictEqual([]);
  });

  it("leaves assignable out of snapshotFor", () => {
    const snapshot = snapshotFor(
      policy,
      { principal: { id: "u1", tenant: "o1", memberships }, context: {} },
      { tenant: "o1", tenants: "all", omitAssignable: true },
    );

    expect(snapshot.assignable).toBeUndefined();
    expect(snapshot.grants.length).toBeGreaterThan(0);
  });
});
