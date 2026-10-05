import { describe, expectTypeOf, it } from "vitest";

import type {
  CustomRoleDropReason,
  CustomRoleGrant,
  ResourceLevel,
} from "../../src/index.ts";

import {
  createPermDock,
  definePermissions,
  principal,
  resource,
} from "../../src/index.ts";
import { memberUser, policy } from "../fixtures/quick-start.ts";

describe("resource levels", () => {
  it("accepts a where object per level and a level on a custom-role grant", () => {
    const permissions = definePermissions({
      job: resource({
        id: "id",
        actions: ["read"],
        levels: { own: { ownerId: principal.id }, all: {} },
      }),
    });
    expectTypeOf(permissions.job.read.key).toEqualTypeOf<"job.read">();
    expectTypeOf<{ readonly ownerId: string }>().toExtend<ResourceLevel>();
    expectTypeOf<{
      permission: "job.read";
      level: "own";
    }>().toExtend<CustomRoleGrant>();
    expectTypeOf<"unknown-level">().toExtend<CustomRoleDropReason>();
  });

  it("assignableLevels returns level names", async () => {
    const permdock = await createPermDock(policy, memberUser);
    expectTypeOf(permdock.assignableLevels).returns.toEqualTypeOf<
      readonly string[]
    >();
  });
});
