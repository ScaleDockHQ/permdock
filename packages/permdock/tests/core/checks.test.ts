import { describe, expect, it } from "vitest";

import type { Decision, Permission } from "../../src/index.ts";

import { wrapPermDock } from "../../src/core/wrap.ts";
import { fromSnapshot, getPermDockSync } from "../../src/index.ts";
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

describe("canAll", () => {
  it("is true only when every check is granted", () => {
    const permdock = getPermDockSync(policy, memberUser);
    expect(
      permdock.canAll([
        permissions.post.list,
        permissions.post.create,
        [permissions.post.update, ownPost],
      ]),
    ).toBe(true);
    expect(
      permdock.canAll([
        permissions.post.list,
        [permissions.post.update, otherPost],
      ]),
    ).toBe(false);
  });

  it("is false for an empty list", () => {
    expect(getPermDockSync(policy, adminUser).canAll([])).toBe(false);
  });

  it("is false for a subject with no principal", () => {
    expect(getPermDockSync(policy, null).canAll([permissions.post.list])).toBe(
      false,
    );
  });

  it("answers the same on an instance built from a snapshot", () => {
    const snapshot = getPermDockSync(policy, memberUser).snapshot();
    const permdock = fromSnapshot(snapshot);
    expect(
      permdock.canAll([
        permissions.post.list,
        [permissions.post.read, ownPost],
      ]),
    ).toBe(true);
    expect(permdock.canAll([permissions.post.publish])).toBe(false);
  });
});

describe("decideAll", () => {
  it("answers one frozen decision per check, in check order", () => {
    const decisions = getPermDockSync(policy, memberUser).decideAll([
      permissions.post.list,
      [permissions.post.update, otherPost],
      [permissions.post.delete, ownPost],
    ]);
    expect(decisions.map((decision) => decision.outcome)).toEqual([
      "granted",
      "denied",
      "approval-required",
    ]);
    expect(Object.isFrozen(decisions)).toBe(true);
  });

  it("answers the same on an instance built from a snapshot", () => {
    const permdock = fromSnapshot(
      getPermDockSync(policy, memberUser).snapshot(),
    );
    const decisions = permdock.decideAll([
      permissions.post.list,
      permissions.post.publish,
    ]);
    expect(decisions.map((decision) => decision.outcome)).toEqual([
      "granted",
      "denied",
    ]);
  });

  it("matches decide for each check", () => {
    const permdock = getPermDockSync(policy, adminUser);
    const [decision] = permdock.decideAll([
      [permissions.post.publish, otherPost],
    ]);
    expect(decision?.outcome).toBe(
      permdock.decide(permissions.post.publish, otherPost).outcome,
    );
  });
});

describe("a wrapped instance", () => {
  it("routes canAll and decideAll through the wrapper's can and decide", () => {
    const seen: string[] = [];
    const wrapped = wrapPermDock(
      getPermDockSync(policy, adminUser),
      (inner) => ({
        // SAFETY: the override forwards every overload's arguments unchanged.
        can: ((permission: Permission, data?: unknown) => {
          seen.push(`can ${permission.key}`);
          return inner.can(permission, data);
        }) as typeof inner.can,
        // SAFETY: the override forwards every overload's arguments unchanged.
        decide: ((permission: Permission, data?: unknown): Decision => {
          seen.push(`decide ${permission.key}`);
          return inner.decide(permission, data);
        }) as typeof inner.decide,
      }),
    );
    wrapped.canAll([permissions.post.list]);
    wrapped.decideAll([permissions.post.create]);
    expect(seen).toEqual(["can post.list", "decide post.create"]);
  });
});
