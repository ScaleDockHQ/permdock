import { describe, expect, it } from "vitest";

import type { Snapshot } from "../../src/core/interfaces.ts";
import type { Membership } from "../../src/core/subject.ts";

import {
  memoryMembershipSource,
  memoryRoleSource,
  memorySnapshotSource,
} from "../../src/core/interfaces.ts";
import {
  testMembershipSource,
  testRoleSource,
  testSnapshotSource,
} from "../../src/testing/conformance.ts";

const snapshot: Snapshot = {
  v: 1,
  issuedAt: 1,
  subject: { principal: null, context: {} },
  roles: [],
  grants: [],
  tenants: [],
};

const memberships: Record<string, Membership[]> = {
  alice: [{ scope: "organization", id: "o1", roles: ["admin"] }],
  bob: [
    { scope: "organization", id: "o1", roles: ["viewer"] },
    { tenant: "o2", roles: ["member"] },
  ],
};

describe("memoryMembershipSource conformance", () => {
  testMembershipSource(memoryMembershipSource(memberships), {
    principals: [{ id: "alice" }, { id: "bob" }, { id: "nobody" }],
    expect: { ...memberships, nobody: [] },
  });
});

describe("memorySnapshotSource conformance", () => {
  testSnapshotSource(memorySnapshotSource(snapshot));
});

describe("memoryRoleSource conformance", () => {
  testRoleSource(
    memoryRoleSource([
      { tenant: "o1", name: "staff", includes: ["member"] },
      { scope: "global", name: "auditor", includes: ["viewer"] },
    ]),
    { tenant: "o1", declared: ["member", "viewer"] },
  );
});

describe("memoryMembershipSource", () => {
  it("lists the members of one scope instance", async () => {
    const source = memoryMembershipSource(memberships);
    const members = await source.list?.({ scope: "organization", id: "o1" });
    expect(members?.map((entry) => entry.principal.id)).toEqual([
      "alice",
      "bob",
    ]);
    expect(await source.list?.({ scope: "organization", id: "o9" })).toEqual(
      [],
    );
  });

  it("returns a copy a caller cannot use to change the source", async () => {
    const source = memoryMembershipSource(memberships);
    const first = await source.membershipsFor({ id: "alice" }, {});
    first.length = 0;
    expect(await source.membershipsFor({ id: "alice" }, {})).toHaveLength(1);
    expect(Object.isFrozen(source)).toBe(true);
  });
});

describe("memorySnapshotSource", () => {
  it("replaces the snapshot and notifies each subscriber until it leaves", async () => {
    const source = memorySnapshotSource(snapshot);
    const next: Snapshot = { ...snapshot, issuedAt: 2 };
    let calls = 0;
    const unsubscribe = source.subscribe?.(() => {
      calls += 1;
    });
    source.set(next);
    expect(await source.get()).toBe(next);
    expect(calls).toBe(1);
    unsubscribe?.();
    source.set("aaa.bbb.ccc");
    expect(await source.get()).toBe("aaa.bbb.ccc");
    expect(calls).toBe(1);
  });
});

describe("memoryRoleSource", () => {
  it("keeps global roles apart from tenant roles", async () => {
    const source = memoryRoleSource([
      { tenant: "o1", name: "staff", includes: ["member"] },
      { scope: "global", name: "auditor", includes: ["viewer"] },
    ]);
    expect((await source.rolesFor("o1")).map((role) => role.name)).toEqual([
      "staff",
    ]);
    expect(await source.rolesFor("o2")).toEqual([]);
    expect((await source.globalRoles?.())?.map((role) => role.name)).toEqual([
      "auditor",
    ]);
  });
});
