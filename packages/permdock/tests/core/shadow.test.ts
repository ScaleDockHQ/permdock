import { describe, expect, it } from "vitest";

import type { ShadowMismatch } from "../../src/core/shadow.ts";

import { internalsOf } from "../../src/core/internals.ts";
import {
  PermDockDeniedError,
  allow,
  getPermDockSync,
  definePermissions,
  definePolicy,
  resource,
  role,
  shadowMode,
  whoCan,
  wrapPermDock,
} from "../../src/index.ts";

const permissions = definePermissions({
  post: resource({
    actions: ["read", "update", "delete"],
    collection: ["list"],
  }),
});
const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.post.read),
      allow(permissions.post.list),
      allow(permissions.post.delete, { approval: "human" }),
    ]),
  ],
  subject: (
    user: { readonly id: string; readonly roles: readonly string[] } | null,
  ) => user,
});
const member = { id: "u1", roles: ["member"] };

describe("shadowMode", () => {
  it("returns the legacy answer and reports where PermDock disagrees", async () => {
    const mismatches: ShadowMismatch[] = [];
    const permdock = shadowMode({
      // The legacy app lets members update but not list.
      legacy: ({ permission }) => permission.key !== "post.list",
      onMismatch: (mismatch) => {
        mismatches.push(mismatch);
      },
    })(getPermDockSync(policy, member));
    expect(permdock.can(permissions.post.update, { id: "p1" })).toBe(true);
    expect(permdock.can(permissions.post.list)).toBe(false);
    expect(permdock.can(permissions.post.read, { id: "p1" })).toBe(true);
    expect(mismatches).toStrictEqual([
      {
        permission: "post.update",
        principal: "u1",
        legacy: true,
        permdock: "denied",
        enforced: false,
      },
      {
        permission: "post.list",
        principal: "u1",
        legacy: false,
        permdock: "granted",
        enforced: false,
      },
    ]);
  });

  it("returns PermDock's answer for an enforced permission", async () => {
    const permdock = shadowMode({
      legacy: () => true,
      enforce: [permissions.post.update],
    })(getPermDockSync(policy, member));
    expect(permdock.can(permissions.post.update, { id: "p1" })).toBe(false);
    expect(() =>
      permdock.assert(permissions.post.update, { id: "p1" }),
    ).toThrow(PermDockDeniedError);
    expect(
      shadowMode({ legacy: () => false, enforce: "all" })(
        getPermDockSync(policy, member),
      ).decide(permissions.post.delete, { id: "p1" }).outcome,
    ).toBe("approval-required");
  });

  it("denies when the legacy check throws, and keeps filter and decideEach in step", async () => {
    const permdock = shadowMode({
      legacy: ({ data }) => {
        if (data === "boom") {
          throw new Error("legacy down");
        }
        return true;
      },
      onMismatch: () => {
        throw new Error("reporting never changes a decision");
      },
    })(getPermDockSync(policy, member));
    expect(permdock.can(permissions.post.read, "boom")).toBe(false);
    expect(
      permdock.filter(permissions.post.read, [{ id: "a" }, { id: "b" }]),
    ).toHaveLength(2);
    expect(
      permdock
        .decideEach(permissions.post.update, [{ id: "a" }])
        .map((item) => item.outcome),
    ).toStrictEqual(["granted"]);
  });
});

describe("wrapPermDock", () => {
  it("keeps feature functions working on a wrapped instance", async () => {
    const wrapped = wrapPermDock(getPermDockSync(policy, member), () => ({}));
    expect(internalsOf(wrapped)).toBeDefined();
    const listed = await whoCan(wrapped, permissions.post.read, { id: "p1" });
    expect(listed.permission).toBe("post.read");
  });
});
