import { describe, expect, it } from "vitest";

import type { ScanResult } from "../../src/cli/types.ts";
import type { CustomRole, Membership } from "../../src/core/subject.ts";

import { buildCatalog } from "../../src/cli/catalog-doc.ts";
import { principal } from "../../src/conditions/refs.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { memoryCustomRoleSource } from "../../src/core/memory-sources.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";

function permissionsWith(ordered: boolean) {
  return definePermissions({
    job: resource({
      id: "id",
      actions: ["read", "update", "close"],
      relations: { org: { field: "orgId", memberOf: "tenant" } },
      levels: {
        own: { ownerId: principal.id },
        team: { teamId: { in: principal["teamIds"] } },
        all: {},
      },
      ...(ordered ? { orderedLevels: true as const } : {}),
    }),
  });
}

const roles = defineRoles({ lead: { on: "tenant" }, member: { on: "tenant" } });

function policyWith(ordered: boolean) {
  const permissions = permissionsWith(ordered);
  const policy = definePolicy(
    { permissions, roles },
    {
      scopes: { tenant: { key: "orgId" } },
      subject: (user: { readonly id: string } | null) =>
        user === null ? null : { id: user.id },
      roles: [
        role(roles.lead, [
          allow(permissions.job.read),
          allow(permissions.job.update, {
            where: { teamId: { in: principal["teamIds"] } },
          }),
          allow(permissions.job.close),
        ]),
        role(roles.member, [
          allow(permissions.job.read, { where: { ownerId: principal.id } }),
        ]),
      ],
    },
  );
  return { permissions, policy };
}

const teamCloser: CustomRole = {
  tenant: "acme",
  name: "team-closer",
  grants: [{ permission: "job.close", level: "team" }],
};
const ownUpdater: CustomRole = {
  tenant: "acme",
  name: "own-updater",
  grants: [{ permission: "job.update", level: "own" }],
};

function permdockFor(
  ordered: boolean,
  memberships: readonly Membership[],
  customRoles: readonly CustomRole[] = [teamCloser, ownUpdater],
) {
  const { permissions, policy } = policyWith(ordered);
  const permdock = getPermDockSync(
    policy,
    {
      principal: { id: "u1", memberships, tenant: "acme", teamIds: ["t1"] },
      context: {},
    },
    { tenant: "acme", customRoles: memoryCustomRoleSource(customRoles) },
  );
  return { permissions, policy, permdock };
}

const lead: Membership = { scope: "tenant", id: "acme", roles: ["lead"] };

describe("orderedLevels", () => {
  it("lets a conditioned grant hand out every narrower level", () => {
    const unordered = permdockFor(false, [lead]);
    expect(
      unordered.permdock.assignableLevels(unordered.permissions.job.update),
    ).toStrictEqual(["team"]);
    const ordered = permdockFor(true, [lead]);
    expect(
      ordered.permdock.assignableLevels(ordered.permissions.job.update),
    ).toStrictEqual(["own", "team"]);
  });

  it("lets a custom-role level hand out every narrower level", () => {
    const holder: Membership = {
      scope: "tenant",
      id: "acme",
      roles: ["team-closer"],
    };
    const unordered = permdockFor(false, [holder]);
    expect(
      unordered.permdock.assignableLevels(unordered.permissions.job.close),
    ).toStrictEqual(["team"]);
    const ordered = permdockFor(true, [holder]);
    expect(
      ordered.permdock.assignableLevels(ordered.permissions.job.close),
    ).toStrictEqual(["own", "team"]);
  });

  it("offers a custom role at a narrower level only when ordered", () => {
    const keys = (ordered: boolean) =>
      permdockFor(ordered, [lead])
        .permdock.assignableRoles()
        .map((leaf) => leaf.key);
    expect(keys(false)).not.toContain("own-updater");
    expect(keys(true)).toContain("own-updater");
  });

  it("never hands out a wider level", () => {
    const ordered = permdockFor(true, [
      { scope: "tenant", id: "acme", roles: ["member"] },
    ]);
    expect(
      ordered.permdock.assignableLevels(ordered.permissions.job.read),
    ).toStrictEqual(["own"]);
  });

  it("leaves decisions unchanged", () => {
    const own = { id: "j1", orgId: "acme", ownerId: "u1", teamId: "t9" };
    const team = { id: "j2", orgId: "acme", ownerId: "u2", teamId: "t1" };
    for (const ordered of [false, true]) {
      const { permdock, permissions } = permdockFor(ordered, [
        { scope: "tenant", id: "acme", roles: ["team-closer"] },
      ]);
      expect(permdock.decide(permissions.job.close, team).outcome).toBe(
        "granted",
      );
      expect(permdock.decide(permissions.job.close, own).outcome).toBe(
        "denied",
      );
    }
  });

  it("carries the levels through the snapshot", () => {
    const { permdock, permissions } = permdockFor(true, [lead]);
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected JSON snapshot");
    }
    const client = fromSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(client.assignableLevels(permissions.job.update)).toStrictEqual([
      "own",
      "team",
    ]);
  });

  it("changes the fingerprint only when set", () => {
    const again = policyWith(false).policy;
    expect(policyWith(false).policy.fingerprint).toBe(again.fingerprint);
    expect(policyWith(true).policy.fingerprint).not.toBe(again.fingerprint);
    expect(policyWith(true).policy.orderedLevels).toStrictEqual(["job"]);
    expect(again.orderedLevels).toBeUndefined();
  });

  it("needs at least two levels and is only true", () => {
    expect(() =>
      definePermissions({
        job: resource({
          actions: ["read"],
          levels: { all: {} },
          orderedLevels: true,
        }),
      }),
    ).toThrow(/orderedLevels with fewer than two levels/u);
    expect(() =>
      definePermissions({
        job: resource({
          actions: ["read"],
          levels: { own: { ownerId: principal.id }, all: {} },
          // @ts-expect-error orderedLevels is `true` or absent
          orderedLevels: false,
        }),
      }),
    ).toThrow(/must be true/u);
  });

  it("marks the catalog entries", () => {
    const scan: ScanResult = {
      roots: [],
      definitionFiles: {},
      usages: {},
      unknown: [],
      dynamic: [],
      roleNames: [],
      planNames: [],
      allowKeys: [],
      snapshots: [],
      unparsed: [],
    };
    const at = "2026-10-21T00:00:00.000Z";
    const ordered = buildCatalog(permissionsWith(true), scan, at);
    const plain = buildCatalog(permissionsWith(false), scan, at);
    const read = (catalog: typeof ordered) =>
      catalog.permissions.find((item) => item.key === "job.read");
    expect(read(ordered)?.orderedLevels).toBe(true);
    expect(read(plain)).not.toHaveProperty("orderedLevels");
  });
});
