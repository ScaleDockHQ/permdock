import { describe, expect, it } from "vitest";

import type { Snapshot } from "../../src/core/interfaces.ts";
import type { Subject } from "../../src/core/subject.ts";

import { scopeList } from "../../src/core/scopes.ts";
import {
  heldRoleNames,
  subjectFromSnapshot,
} from "../../src/core/snapshot-subject.ts";

const scopes = scopeList([
  { name: "org", key: "orgId" },
  { name: "project", key: "projectId", within: "org" },
]);

const subject: Subject = {
  principal: {
    id: "u1",
    roles: ["global-admin"],
    tenant: "o1",
    memberships: [
      { scope: "org", id: "o1", roles: ["viewer", "owner"] },
      { scope: "org", id: "o2", roles: ["member"] },
      { scope: "project", id: "p1", within: { org: "o1" }, roles: ["editor"] },
      { scope: "project", id: "p2", within: { org: "o1" }, roles: ["lead"] },
      {
        scope: "project",
        id: "p3",
        within: { org: "o1" },
        roles: ["stale"],
        expiresAt: 5,
      },
    ],
  },
  context: {},
};

describe("heldRoleNames", () => {
  it("lists global roles and the roles held in the tenant, ranked", () => {
    expect(
      heldRoleNames(subject, "o1", scopes, { rank: ["owner", "viewer"] }, 10),
    ).toEqual(["owner", "viewer", "global-admin", "editor", "lead"]);
    expect(heldRoleNames(subject, "o2", scopes, undefined, 10)).toEqual([
      "global-admin",
      "member",
    ]);
  });

  it("keeps only memberships of one scope, and of one instance when an id is given", () => {
    expect(
      heldRoleNames(subject, "o1", scopes, { scope: "project" }, 10),
    ).toEqual(["editor", "lead"]);
    expect(
      heldRoleNames(subject, "o1", scopes, { scope: "project", id: "p2" }, 10),
    ).toEqual(["lead"]);
    expect(
      heldRoleNames(subject, "o1", scopes, { scope: "tenant", id: "o2" }, 10),
    ).toEqual(["member"]);
  });

  it("skips expired memberships and returns nothing for an undeclared scope", () => {
    expect(
      heldRoleNames(subject, "o1", scopes, { scope: "project" }, 1),
    ).toEqual(["editor", "lead", "stale"]);
    expect(
      heldRoleNames(subject, "o1", scopes, { scope: "workspace" }),
    ).toEqual([]);
  });

  it("holds nothing for an anonymous subject", () => {
    const anonymous: Subject = { principal: null, context: {} };
    expect(heldRoleNames(anonymous, "o1", scopes)).toEqual([]);
    expect(heldRoleNames(anonymous, "o1", scopes, { scope: "org" })).toEqual(
      [],
    );
  });
});

describe("subjectFromSnapshot", () => {
  const base: Snapshot = {
    v: 1,
    issuedAt: 0,
    subject: { principal: { id: "u1", roles: [], tenant: "t1" }, context: {} },
    roles: [],
    grants: [],
    tenants: [],
    expiresAt: 99,
  };

  it("keeps the snapshot tenant, and selects a requested one only with a membership", () => {
    expect(subjectFromSnapshot(base, undefined).principal?.tenant).toBe("t1");
    expect(subjectFromSnapshot(base, "t2").principal?.tenant).toBeUndefined();
    const member: Snapshot = {
      ...base,
      subject: {
        principal: {
          id: "u1",
          roles: [],
          memberships: [{ scope: "tenant", id: "t2", roles: ["member"] }],
        },
        context: {},
      },
    };
    const resolved = subjectFromSnapshot(member, "t2");
    expect(resolved.principal?.tenant).toBe("t2");
    expect(resolved.expiresAt).toBe(99);
  });

  it("returns an anonymous subject for a snapshot without a principal", () => {
    const anonymous = subjectFromSnapshot(
      { ...base, subject: { principal: null, context: { ip: "x" } } },
      "t1",
    );
    expect(anonymous.principal).toBeNull();
    expect(anonymous.context).toEqual({ ip: "x" });
  });
});
