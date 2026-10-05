import { describe, expect, it } from "vitest";

import type { ScanResult } from "../../src/cli/types.ts";
import type { CustomRole, Membership } from "../../src/core/subject.ts";

import { buildCatalog } from "../../src/cli/catalog-doc.ts";
import { diffCatalogs } from "../../src/cli/diff.ts";
import { principal } from "../../src/conditions/refs.ts";
import {
  customRoleClaim,
  resolveCustomRole,
  validateCustomRole,
} from "../../src/core/custom-roles.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { memoryRoleSource } from "../../src/core/interfaces.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, deny, role } from "../../src/core/policy.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";
import { reasonOf } from "../fixtures/decisions.ts";

const permissions = definePermissions({
  job: resource({
    id: "id",
    actions: ["read", "update", "close"],
    collection: ["create"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
    levels: {
      own: { ownerId: principal.id },
      team: { teamId: { in: principal["teamIds"] } },
      all: {},
    },
  }),
  member: resource({
    collection: { assignRole: { manageRoles: true } },
  }),
});

const roles = defineRoles({
  admin: { on: "tenant" },
  manager: { on: "tenant" },
  member: { on: "tenant" },
  steward: { on: "tenant", meta: { manageRoles: true } },
});

const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { tenant: { key: "orgId" } },
    subject: (user: { readonly id: string } | null) =>
      user === null ? null : { id: user.id },
    roles: [
      role(roles.admin, [
        allow(permissions.job.read),
        allow(permissions.job.update),
        allow(permissions.job.close),
        allow(permissions.job.create),
      ]),
      role(roles.manager, [
        allow(permissions.job.read),
        allow(permissions.job.update, {
          where: { teamId: { in: principal["teamIds"] } },
        }),
      ]),
      role(roles.member, [
        allow(permissions.job.read, { where: { ownerId: principal.id } }),
      ]),
      role(roles.steward, []),
    ],
  },
);

const ownJob = { id: "j1", orgId: "acme", ownerId: "u1", teamId: "t9" };
const teamJob = { id: "j2", orgId: "acme", ownerId: "u2", teamId: "t1" };
const otherJob = { id: "j3", orgId: "acme", ownerId: "u3", teamId: "t3" };

function subjectIn(memberships: readonly Membership[]) {
  return {
    principal: { id: "u1", memberships, tenant: "acme", teamIds: ["t1"] },
    context: {},
  };
}

async function permdockFor(
  memberships: readonly Membership[],
  customRoles: readonly CustomRole[],
) {
  return createPermDock(policy, subjectIn(memberships), {
    tenant: "acme",
    customRoles: memoryRoleSource(customRoles),
  });
}

const dispatcher: CustomRole = {
  tenant: "acme",
  name: "dispatcher",
  grants: [
    { permission: "job.read", level: "team" },
    { permission: "job.update", level: "own" },
    { permission: "job.close", level: "own" },
    { permission: "job.close", level: "team" },
  ],
};

describe("resource levels", () => {
  it("rejects a malformed level name or a resource without instance actions", () => {
    expect(() =>
      definePermissions({
        job: resource({
          id: "id",
          actions: ["read"],
          levels: { Own: { ownerId: principal.id } },
        }),
      }),
    ).toThrow(/level/u);
    expect(() =>
      definePermissions({
        job: resource({ collection: ["create"], levels: { all: {} } }),
      }),
    ).toThrow(/level/u);
  });

  it("freezes the levels on the resource node", () => {
    expect(Object.isFrozen(policy.levels)).toBe(true);
    expect(Object.keys(policy.levels?.["job"] ?? {})).toEqual([
      "own",
      "team",
      "all",
    ]);
  });
});

describe("resolveCustomRole with levels", () => {
  it("ANDs the level condition into the ceiling grant", async () => {
    const permdock = await permdockFor(
      [{ scope: "tenant", id: "acme", roles: ["dispatcher"] }],
      [dispatcher],
    );
    expect(permdock.decide(permissions.job.read, ownJob).outcome).toBe(
      "denied",
    );
    expect(permdock.decide(permissions.job.read, teamJob).outcome).toBe(
      "granted",
    );
    expect(permdock.decide(permissions.job.update, ownJob).outcome).toBe(
      "granted",
    );
    expect(permdock.decide(permissions.job.update, teamJob).outcome).toBe(
      "denied",
    );
    expect(permdock.decide(permissions.job.close, ownJob).outcome).toBe(
      "granted",
    );
    expect(permdock.decide(permissions.job.close, teamJob).outcome).toBe(
      "granted",
    );
    expect(permdock.decide(permissions.job.close, otherJob).outcome).toBe(
      "denied",
    );
  });

  it("keeps the ceiling condition under a level", () => {
    const resolved = resolveCustomRole(policy, {
      tenant: "acme",
      name: "mixed",
      grants: [{ permission: "job.update", level: "all" }],
    });
    expect(resolved.dropped).toEqual([]);
    const update = resolved.grants.filter(
      (grant) => grant.permission.key === "job.update",
    );
    expect(update.length).toBeGreaterThan(0);
    expect(update.every((grant) => grant.level === "all")).toBe(true);
  });

  it("an allow without a level keeps every level of the ceiling", () => {
    const resolved = resolveCustomRole(policy, {
      tenant: "acme",
      name: "wide",
      grants: [
        { permission: "job.read", level: "own" },
        { permission: "job.read" },
      ],
    });
    const read = resolved.grants.filter(
      (grant) => grant.permission.key === "job.read",
    );
    expect(read.every((grant) => grant.level === undefined)).toBe(true);
  });

  it("drops an unknown level and denies the permission, never widening", async () => {
    const typo: CustomRole = {
      tenant: "acme",
      name: "typo",
      includes: ["admin"],
      grants: [
        { permission: "job.read", level: "everything" },
        { permission: "job.create", level: "own" },
      ],
    };
    const resolved = resolveCustomRole(policy, typo);
    expect(resolved.dropped).toEqual([
      { permission: "job.read", reason: "unknown-level", level: "everything" },
      { permission: "job.create", reason: "unknown-level", level: "own" },
    ]);
    const permdock = await permdockFor(
      [{ scope: "tenant", id: "acme", roles: ["typo"] }],
      [typo],
    );
    const decision = permdock.decide(permissions.job.read, ownJob);
    expect(decision.outcome).toBe("denied");
    expect(reasonOf(decision)).toBe("no-grant");
    expect(permdock.decide(permissions.job.update, ownJob).outcome).toBe(
      "granted",
    );
  });

  it("rejects a level on a deny and a level of a permission outside the ceiling", () => {
    const resolved = resolveCustomRole(policy, {
      tenant: "acme",
      name: "odd",
      grants: [
        { permission: "job.read", effect: "deny", level: "own" },
        { permission: "member.assignRole", level: "all" },
      ],
    });
    expect(resolved.dropped).toEqual([
      { permission: "job.read", reason: "condition-not-allowed" },
      {
        permission: "member.assignRole",
        reason: "unknown-level",
        level: "all",
      },
    ]);
    expect(
      validateCustomRole(policy, {
        tenant: "acme",
        name: "odd",
        grants: [{ permission: "job.read", effect: "deny", level: "own" }],
      }).ok,
    ).toBe(false);
  });

  it("validateCustomRole accepts known levels", () => {
    expect(validateCustomRole(policy, dispatcher)).toEqual({
      ok: true,
      permissions: ["job.close", "job.read", "job.update"],
      dropped: [],
      renamed: [],
    });
  });

  it("customRoleClaim writes key@level entries", () => {
    expect(customRoleClaim([dispatcher])).toEqual({
      dispatcher: [
        "job.read@team",
        "job.update@own",
        "job.close@own",
        "job.close@team",
      ],
    });
  });

  it("decide and fromSnapshot agree under levels", async () => {
    const memberships: readonly Membership[] = [
      { scope: "tenant", id: "acme", roles: ["dispatcher"] },
    ];
    const server = await permdockFor(memberships, [dispatcher]);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error("expected JSON snapshot");
    }
    const client = fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
    for (const leaf of [
      permissions.job.read,
      permissions.job.update,
      permissions.job.close,
    ]) {
      for (const row of [ownJob, teamJob, otherJob]) {
        expect([leaf.key, row.id, client.decide(leaf, row).outcome]).toEqual([
          leaf.key,
          row.id,
          server.decide(leaf, row).outcome,
        ]);
      }
    }
    const cached = snapshotFor(policy, subjectIn(memberships), {
      tenant: "acme",
      customRoles: [dispatcher],
      now: snapshot.issuedAt,
    });
    expect(cached).toEqual(snapshot);
  });
});

describe("assignableLevels", () => {
  it("lists every level for a manageRoles holder", async () => {
    const permdock = await permdockFor(
      [{ scope: "tenant", id: "acme", roles: ["steward"] }],
      [],
    );
    expect(permdock.assignableLevels(permissions.job.update)).toEqual([
      "own",
      "team",
      "all",
    ]);
  });

  it("lists the levels the subject holds", async () => {
    const member = await permdockFor(
      [{ scope: "tenant", id: "acme", roles: ["member"] }],
      [],
    );
    expect(member.assignableLevels(permissions.job.read)).toEqual(["own"]);
    expect(member.assignableLevels(permissions.job.update)).toEqual([]);
    const manager = await permdockFor(
      [{ scope: "tenant", id: "acme", roles: ["manager"] }],
      [],
    );
    expect(manager.assignableLevels(permissions.job.read)).toEqual([
      "own",
      "team",
      "all",
    ]);
    expect(manager.assignableLevels(permissions.job.update)).toEqual(["team"]);
    const custom = await permdockFor(
      [{ scope: "tenant", id: "acme", roles: ["dispatcher"] }],
      [dispatcher],
    );
    expect(custom.assignableLevels(permissions.job.close)).toEqual([
      "own",
      "team",
    ]);
  });

  it("matches the snapshot and returns nothing for a collection permission", async () => {
    const permdock = await permdockFor(
      [{ scope: "tenant", id: "acme", roles: ["manager"] }],
      [],
    );
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error("expected JSON snapshot");
    }
    const client = fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(client.assignableLevels(permissions.job.update)).toEqual(["team"]);
    expect(permdock.assignableLevels(permissions.job.create)).toEqual([]);
  });
});

describe("deny with levels", () => {
  it("a role deny still overrides a leveled allow", async () => {
    const denying = definePolicy(
      { permissions, roles },
      {
        scopes: { tenant: { key: "orgId" } },
        subject: () => null,
        roles: [
          role(roles.admin, [
            allow(permissions.job.read),
            deny(permissions.job.read, { where: { teamId: "t1" } }),
          ]),
        ],
      },
    );
    const resolved = resolveCustomRole(denying, {
      tenant: "acme",
      name: "reader",
      grants: [{ permission: "job.read", level: "team" }],
    });
    const permdock = await createPermDock(
      denying,
      subjectIn([{ scope: "tenant", id: "acme", roles: ["reader"] }]),
      {
        tenant: "acme",
        customRoles: memoryRoleSource([
          {
            tenant: "acme",
            name: "reader",
            grants: [{ permission: "job.read", level: "team" }],
          },
        ]),
      },
    );
    expect(resolved.dropped).toEqual([]);
    expect(permdock.decide(permissions.job.read, teamJob).outcome).toBe(
      "denied",
    );
  });
});

const EMPTY_SCAN: ScanResult = {
  roots: [],
  definitionFiles: {},
  usages: {},
  unknown: [],
  dynamic: [],
  roleNames: [],
  planNames: [],
  allowKeys: [],
  snapshots: [],
};

describe("catalog and diff with levels", () => {
  const at = "2026-10-05T00:00:00.000Z";
  const narrower = definePermissions({
    job: resource({
      id: "id",
      actions: ["read", "update", "close"],
      collection: ["create"],
      relations: { org: { field: "orgId", memberOf: "tenant" } },
      levels: {
        own: { ownerId: principal.id },
        region: { regionId: principal["regionId"] },
      },
    }),
    member: resource({
      collection: { assignRole: { manageRoles: true } },
    }),
  });
  const before = buildCatalog(permissions, EMPTY_SCAN, at);
  const after = buildCatalog(narrower, EMPTY_SCAN, at);

  it("lists the levels of each instance permission", () => {
    const read = before.permissions.find((item) => item.key === "job.read");
    expect(read?.levels).toEqual(["own", "team", "all"]);
    const create = before.permissions.find((item) => item.key === "job.create");
    expect(create?.levels).toBeUndefined();
  });

  it("reports a removed level as breaking and an added level as not", () => {
    const result = diffCatalogs(
      { source: "a", catalog: before, policy: undefined },
      { source: "b", catalog: after, policy: undefined },
    );
    expect(result.levels.removed).toContainEqual({
      permission: "job.read",
      level: "team",
    });
    expect(result.levels.added).toContainEqual({
      permission: "job.read",
      level: "region",
    });
    expect(result.breaking.map((item) => item.kind)).toContain("level-removed");
    expect(
      result.breaking.filter((item) => item.kind === "level-removed"),
    ).toHaveLength(6);
  });
});
