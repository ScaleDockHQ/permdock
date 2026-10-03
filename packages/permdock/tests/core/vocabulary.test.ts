import { describe, expect, it } from "vitest";

import type { PlanTree, RoleTree } from "../../src/core/vocabulary.ts";

import {
  definePlans,
  defineRoles,
  findRole,
  isPlan,
  isRole,
  listPlans,
  listRoles,
  synthesiseRole,
} from "../../src/core/vocabulary.ts";

describe("vocabulary", () => {
  it("defines a role or plan from an undefined init with defaults", () => {
    // SAFETY: an undefined init, as a JavaScript caller could pass it.
    const roles = defineRoles({
      viewer: undefined as never,
      admin: { on: "tenant" },
    });
    expect(roles.viewer).toEqual({
      key: "viewer",
      assignable: false,
      meta: {},
    });
    expect(roles.admin).toEqual({
      key: "admin",
      on: "tenant",
      assignable: true,
      meta: {},
    });
    expect(isRole(roles.viewer)).toBe(true);
    // SAFETY: an undefined init, as a JavaScript caller could pass it.
    const plans = definePlans({ free: undefined as never });
    expect(plans.free).toEqual({ key: "free", meta: {} });
    expect(isPlan(plans.free)).toBe(true);
    expect(isPlan(roles.viewer)).toBe(false);
  });

  it("rejects forbidden keys", () => {
    const forbidden = JSON.parse('{"__proto__": {}}');
    expect(() => defineRoles(forbidden)).toThrow(/forbidden role key/u);
    expect(() => definePlans(forbidden)).toThrow(/forbidden plan key/u);
    expect(findRole(defineRoles({ a: {} }), "__proto__")).toBeUndefined();
  });

  it("lists only defined leaves", () => {
    const roles = defineRoles({ a: {} });
    // SAFETY: a tree with a hole, as an untyped caller could build one.
    const holed = { ...roles, b: undefined } as unknown as RoleTree;
    expect(listRoles(holed).map((leaf) => leaf.key)).toEqual(["a"]);
    expect(listRoles(undefined)).toEqual([]);
    const plans = definePlans({ pro: {} });
    // SAFETY: a tree with a hole, as an untyped caller could build one.
    const holedPlans = { ...plans, free: undefined } as unknown as PlanTree;
    expect(listPlans(holedPlans).map((leaf) => leaf.key)).toEqual(["pro"]);
    expect(listPlans(undefined)).toEqual([]);
  });

  it("synthesises roles with and without scope and meta", () => {
    expect(synthesiseRole("x")).toEqual({
      key: "x",
      assignable: false,
      meta: {},
    });
    expect(
      synthesiseRole("x", { meta: { audience: "staff" }, assignable: true }),
    ).toEqual({ key: "x", assignable: true, meta: { audience: "staff" } });
    expect(synthesiseRole("x", { on: "team" })).toEqual({
      key: "x",
      on: "team",
      assignable: false,
      meta: {},
    });
    expect(
      synthesiseRole("x", { on: "team", meta: { audience: "portal" } }),
    ).toEqual({
      key: "x",
      on: "team",
      assignable: false,
      meta: { audience: "portal" },
    });
  });
});
