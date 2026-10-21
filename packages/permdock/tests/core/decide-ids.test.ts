import { describe, expect, it } from "vitest";

import type { Subject } from "../../src/core/subject.ts";

import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";

const permissions = definePermissions({
  doc: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});
const roles = defineRoles({ reader: { on: "tenant" } });
const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { tenant: { key: "orgId" } },
    subject: (user: Subject) => user.principal,
    roles: [role(roles.reader, [allow(permissions.doc.read)])],
  },
);
const subject: Subject = {
  principal: { id: "u1", memberships: [{ tenant: "acme", roles: ["reader"] }] },
  context: {},
};
const rows = [
  { id: "d1", orgId: "acme" },
  { id: "d2", orgId: "globex" },
];

describe("decideIds", () => {
  const permdock = getPermDockSync(policy, subject);
  const outcomes = (decisions: readonly { outcome: string }[]) =>
    decisions.map((decision) => decision.outcome);

  it("decides each loaded row in its own tenant, in id order", async () => {
    const seen: (readonly string[])[] = [];
    const decisions = await permdock.decideIds(
      permissions.doc.read,
      ["d2", "d1"],
      {
        data: (ids) => {
          seen.push(ids);
          return rows;
        },
      },
    );
    expect(seen).toStrictEqual([["d2", "d1"]]);
    expect(outcomes(decisions)).toStrictEqual(["denied", "granted"]);
  });

  it("accepts a map and denies an id with no row as validation", async () => {
    const decisions = await permdock.decideIds(
      permissions.doc.read,
      ["d1", "d9"],
      { data: () => new Map(rows.map((row) => [row.id, row])) },
    );
    expect(outcomes(decisions)).toStrictEqual(["granted", "denied"]);
    expect(decisions[1]).toMatchObject({ denials: [{ reason: "validation" }] });
  });

  it("denies every id with validation when the loader throws", async () => {
    const decisions = await permdock.decideIds(permissions.doc.read, ["d1"], {
      data: () => {
        throw new Error("down");
      },
    });
    expect(decisions[0]).toMatchObject({ denials: [{ reason: "validation" }] });
  });

  it("denies a snapshot instance with unsupported", async () => {
    const client = fromSnapshot(
      parseSnapshot(JSON.stringify(permdock.tenant("acme").snapshot())),
    );
    const decisions = await client.decideIds(permissions.doc.read, ["d1"], {
      data: () => rows,
    });
    expect(decisions[0]).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "unsupported" }],
    });
  });
});
