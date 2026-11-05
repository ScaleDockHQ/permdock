import { describe, expect, it } from "vitest";

import type { Permission } from "../../src/core/permission-types.ts";
import type { Snapshot } from "../../src/core/snapshot-types.ts";

import { createClientStore } from "../../src/client/store.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { listPermissions } from "../../src/core/permission-registry.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { typeLevelOf } from "../../src/core/type-level.ts";
import { allow, definePolicy, role } from "../../src/index.ts";
import {
  adminUser,
  memberUser,
  permissions as postPermissions,
  policy as quickStart,
} from "../fixtures/quick-start.ts";
import { alice, bob, policy as saas } from "../fixtures/saas.ts";

function snapshotFrom(
  built: ReturnType<ReturnType<typeof getPermDockSync>["snapshot"]>,
): Snapshot {
  if (built instanceof Promise) {
    throw new TypeError("expected JSON snapshot");
  }
  return parseSnapshot(built);
}

/**
 * The store's table answer must equal what its evaluator decides for the same
 * rowless check.
 */
function expectParity(
  snapshot: Snapshot,
  permissions: readonly Permission[],
): number {
  const store = createClientStore({ snapshot });
  let answered = 0;
  for (const permission of permissions) {
    const quick = store.quick(permission);
    const decided = store.permissionState(permission);
    if (quick === undefined) {
      continue;
    }
    answered += 1;
    expect({
      key: permission.key,
      allowed: quick.allowed,
      outcome: quick.outcome,
    }).toStrictEqual({
      key: permission.key,
      allowed: decided.allowed,
      outcome: decided.decision.outcome,
    });
  }
  return answered;
}

describe("snapshot typeLevel", () => {
  it("skips a grant whose permission the policy does not declare", () => {
    const snapshot = snapshotFrom(
      getPermDockSync(saas, alice, { tenant: "acme" }).snapshot({ v: 1 }),
    );
    const [first] = snapshot.grants;
    expect(first).toBeDefined();
    const foreign: Snapshot = {
      ...snapshot,
      grants:
        first === undefined
          ? []
          : [...snapshot.grants, { ...first, permission: "ghost.read" }],
    };
    const table = typeLevelOf(saas, foreign);
    expect(table?.granted).not.toContain("ghost.read");
  });

  it("answers every rowless check as the evaluator does, for the saas policy", () => {
    const permissions = listPermissions(saas.permissions);
    for (const [user, tenant] of [
      [alice, "acme"],
      [alice, "globex"],
      [bob, "acme"],
    ] as const) {
      const snapshot = snapshotFrom(
        getPermDockSync(saas, user, { tenant }).snapshot({
          v: 1,
          tenants: "all",
        }),
      );
      expect(snapshot.typeLevel).toBeDefined();
      expect(expectParity(snapshot, permissions)).toBeGreaterThan(0);
    }
  });

  it("separates granted, approval and denied keys in the quick-start policy", () => {
    const permissions = listPermissions(quickStart.permissions);
    const member = snapshotFrom(
      // SAFETY: the fixture users belong to the quick-start policy; only the generic is erased.
      getPermDockSync(quickStart as never, memberUser).snapshot({ v: 1 }),
    );
    const admin = snapshotFrom(
      // SAFETY: the fixture users belong to the quick-start policy; only the generic is erased.
      getPermDockSync(quickStart as never, adminUser).snapshot({ v: 1 }),
    );
    expectParity(member, permissions);
    expectParity(admin, permissions);
  });

  it("lists a key that needs an approver under approval, not granted", () => {
    const gated = definePolicy(postPermissions, {
      roles: [
        role("member", [
          allow(postPermissions.post.read),
          allow(postPermissions.post.publish, { approval: "human" }),
        ]),
      ],
      subject: (user: typeof memberUser | null) =>
        user === null
          ? null
          : { id: user.id, orgId: user.orgId, roles: user.roles },
    });
    const snapshot = snapshotFrom(
      getPermDockSync(gated, memberUser).snapshot({ v: 1 }),
    );
    expect(snapshot.typeLevel?.approval).toStrictEqual(["post.publish"]);
    expect(snapshot.typeLevel?.granted).toStrictEqual(["post.read"]);
    expectParity(snapshot, listPermissions(gated.permissions));
  });

  it("denies a key the table does not list and the evaluator is not asked", () => {
    const snapshot = snapshotFrom(
      getPermDockSync(saas, bob, { tenant: "acme" }).snapshot({ v: 1 }),
    );
    const store = createClientStore({ snapshot });
    const unknown = listPermissions(saas.permissions).find(
      (permission) =>
        !(snapshot.typeLevel?.granted ?? []).includes(permission.key),
    );
    expect(unknown).toBeDefined();
    if (unknown !== undefined) {
      expect(store.quick(unknown)?.outcome).toBe("denied");
    }
  });

  it("is absent when a grant has a validity period, so the clock stays with the evaluator", () => {
    const timed = definePolicy(postPermissions, {
      roles: [
        role("member", [
          allow(postPermissions.post.read, {
            validUntil: "2099-01-01T00:00:00Z",
          }),
        ]),
      ],
      subject: (user: typeof memberUser | null) =>
        user === null
          ? null
          : { id: user.id, orgId: user.orgId, roles: user.roles },
    });
    const snapshot = snapshotFrom(
      getPermDockSync(timed, memberUser).snapshot({ v: 1 }),
    );
    expect(snapshot.typeLevel).toBeUndefined();
    const store = createClientStore({ snapshot });
    for (const permission of listPermissions(timed.permissions)) {
      expect(store.quick(permission)).toBeUndefined();
    }
  });

  it("is not used for another tenant than the one it was built for", () => {
    const snapshot = snapshotFrom(
      getPermDockSync(saas, alice, { tenant: "acme" }).snapshot({
        v: 1,
        tenants: "all",
      }),
    );
    const store = createClientStore({ snapshot, tenant: "globex" });
    for (const permission of listPermissions(saas.permissions)) {
      expect(store.quick(permission)).toBeUndefined();
    }
  });

  it("is dropped by simulate, which changes the subject", () => {
    const real = snapshotFrom(
      getPermDockSync(saas, alice, { tenant: "acme" }).snapshot({ v: 1 }),
    );
    expect(real.typeLevel).toBeDefined();
    const simulated = fromSnapshot(real).simulate({ roles: ["viewer"] });
    expect(
      snapshotFrom(simulated.snapshot({ v: 1 })).typeLevel,
    ).toBeUndefined();
  });

  it("rejects a malformed table when parsing", () => {
    const snapshot = snapshotFrom(
      getPermDockSync(saas, bob, { tenant: "acme" }).snapshot({ v: 1 }),
    );
    expect(() =>
      parseSnapshot({ ...snapshot, typeLevel: { granted: [1] } }),
    ).toThrow(/typeLevel/u);
    expect(() => parseSnapshot({ ...snapshot, typeLevel: [] })).toThrow(
      /typeLevel/u,
    );
  });
});
