import { describe, expect, it } from "vitest";

import type { Membership } from "../../src/core/subject.ts";

import { principal } from "../../src/conditions/refs.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";

const permissions = definePermissions({
  job: resource({
    id: "id",
    actions: ["read", "update"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      team: { field: "teamId", memberOf: "team" },
    },
  }),
});

const roles = defineRoles({
  manager: { on: "tenant" },
  member: { on: "team" },
});

const policy = definePolicy(
  { permissions, roles },
  {
    scopes: {
      tenant: { key: "orgId" },
      team: { key: "teamId", within: "tenant" },
    },
    subject: () => null,
    roles: [
      role(roles.manager, [
        allow([permissions.job.read, permissions.job.update], {
          where: { teamId: { in: principal["teamIds"] } },
        }),
      ]),
      role(roles.member, []),
    ],
  },
);

const memberships: readonly Membership[] = [
  { scope: "tenant", id: "acme", roles: ["manager"] },
  { scope: "team", id: "t1", within: { tenant: "acme" }, roles: ["member"] },
];
const subject = {
  principal: { id: "u1", tenant: "acme", memberships, teamIds: ["t1"] },
  context: {},
};
const inTeam = { id: "j1", orgId: "acme", teamId: "t1" };
const otherTeam = { id: "j2", orgId: "acme", teamId: "t2" };
const otherOrg = { id: "j3", orgId: "globex", teamId: "t1" };

describe("organisation role with team reach", () => {
  it("reaches the rows of the principal's teams inside the active tenant", async () => {
    const permdock = await createPermDock(policy, subject, { tenant: "acme" });
    const outcomes = [inTeam, otherTeam, otherOrg].map((row) => [
      permdock.decide(permissions.job.read, row).outcome,
      permdock.decide(permissions.job.update, row).outcome,
    ]);
    expect(outcomes).toEqual([
      ["granted", "granted"],
      ["denied", "denied"],
      ["denied", "denied"],
    ]);
  });

  it("needs the organisation role as well as the team", async () => {
    const permdock = await createPermDock(
      policy,
      {
        principal: {
          ...subject.principal,
          memberships: memberships.filter(
            (membership) => membership.scope === "team",
          ),
        },
        context: {},
      },
      { tenant: "acme" },
    );
    expect(permdock.decide(permissions.job.read, inTeam).outcome).toBe(
      "denied",
    );
  });

  it("carries teamIds into the snapshot, so the client agrees", async () => {
    const permdock = await createPermDock(policy, subject, { tenant: "acme" });
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error("expected JSON snapshot");
    }
    const client = fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
    for (const leaf of [permissions.job.read, permissions.job.update]) {
      for (const row of [inTeam, otherTeam, otherOrg]) {
        expect(client.decide(leaf, row).outcome).toBe(
          permdock.decide(leaf, row).outcome,
        );
      }
    }
  });
});
