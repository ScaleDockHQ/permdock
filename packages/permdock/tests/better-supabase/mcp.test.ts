import { describe, expect, it } from "vitest";

import type { Subject } from "../../src/core/subject.ts";

import { toolPolicy } from "../../src/better-supabase/index.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { type PermDock, createPermDock } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";

const permissions = definePermissions({
  customer: resource({ actions: ["read", "export", "delete"] }),
});
const { customer } = permissions;
const policy = definePolicy(
  { permissions },
  {
    subject: (user: Subject) => user.principal,
    roles: [
      role("support", [
        allow(customer.read),
        allow(customer.export, { approval: "human" }),
      ]),
    ],
  },
);

const dock = (): PermDock => {
  const instance = createPermDock(policy, {
    principal: { id: "u_1", kind: "user", roles: ["support"] },
    context: {},
  });
  if (instance instanceof Promise) throw new TypeError("expected sync");
  return instance;
};

const tools = toolPolicy({ permdock: dock });
const ctx = {};

describe("toolPolicy", () => {
  it("grants a granted permission and shows the tool", async () => {
    expect(await tools.authorize(ctx, { meta: customer.read }, {})).toEqual({
      allowed: true,
    });
    expect(await tools.visible(ctx, { meta: customer.read })).toBe(true);
  });

  it("refuses and hides a denied permission", async () => {
    expect(await tools.authorize(ctx, { meta: customer.delete }, {})).toEqual({
      allowed: false,
      reason: "PermDock denied customer.delete.",
    });
    expect(await tools.visible(ctx, { meta: customer.delete })).toBe(false);
  });

  it("refuses an approval-required call", async () => {
    expect(
      await tools.authorize(ctx, { meta: customer.export }, {}),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("approval"),
    });
  });

  it("refuses and hides a tool without a permission", async () => {
    expect(await tools.authorize(ctx, { meta: undefined }, {})).toMatchObject({
      allowed: false,
    });
    expect(await tools.visible(ctx, { meta: { key: "x" } })).toBe(false);
  });

  it("refuses when the instance or the row loader throws", async () => {
    const failing = toolPolicy({
      permdock: () => Promise.reject(new Error("down")),
    });
    expect(await failing.authorize(ctx, { meta: customer.read }, {})).toEqual({
      allowed: false,
      reason: "The permission check failed.",
    });
    expect(await failing.visible(ctx, { meta: customer.read })).toBe(false);
    const loader = toolPolicy({
      permdock: dock,
      data: () => {
        throw new Error("no row");
      },
    });
    expect(
      await loader.authorize(ctx, { meta: customer.read }, {}),
    ).toMatchObject({ allowed: false });
  });
});
