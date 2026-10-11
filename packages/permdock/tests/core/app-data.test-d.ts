import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

import type {
  AppData,
  Decision,
  Membership,
  Permission,
  RoleMeta,
} from "../../src/index.ts";

import {
  allow,
  definePermissions,
  definePlans,
  defineRoles,
  getResource,
  resource,
} from "../../src/index.ts";

describe("typed x", () => {
  it("types meta.x on every leaf from the permission schema", () => {
    const tree = definePermissions(
      { invoice: resource({ actions: { send: { x: { risk: "high" } } } }) },
      { x: { permission: z.object({ risk: z.enum(["low", "high"]) }) } },
    );
    expectTypeOf(tree.invoice.send.meta.x?.risk).toEqualTypeOf<
      "low" | "high" | undefined
    >();
    expectTypeOf(tree.invoice.send).toExtend<Permission>();
    allow(tree.invoice.send);
  });

  it("leaves meta.x as AppData without a schema", () => {
    const tree = definePermissions({
      invoice: resource({ actions: ["send"] }),
    });
    expectTypeOf(tree.invoice.send.meta.x).toEqualTypeOf<AppData | undefined>();
  });

  it("types resource meta.x through getResource", () => {
    const tree = definePermissions(
      {
        invoice: resource({
          actions: ["send"],
          meta: { x: { owner: "billing" } },
        }),
      },
      { x: { resource: z.object({ owner: z.string() }) } },
    );
    expectTypeOf(getResource(tree, "invoice")?.meta?.x?.owner).toEqualTypeOf<
      string | undefined
    >();
  });

  it("types role and plan meta.x", () => {
    const roles = defineRoles(
      { admin: { meta: { x: { tier: 1 } } } },
      { x: z.object({ tier: z.number() }) },
    );
    expectTypeOf(roles.admin.meta.x?.tier).toEqualTypeOf<number | undefined>();
    const plans = definePlans(
      { pro: {} },
      { x: z.object({ seats: z.number() }) },
    );
    expectTypeOf(plans.pro.meta.x?.seats).toEqualTypeOf<number | undefined>();
  });

  it("reads grant, membership and custom-role x as AppData", () => {
    expectTypeOf<Membership["x"]>().toEqualTypeOf<AppData | undefined>();
    expectTypeOf<RoleMeta["x"]>().toEqualTypeOf<AppData | undefined>();
    type Matched = Extract<Decision, { outcome: "granted" }>["matched"];
    expectTypeOf<NonNullable<Matched["meta"]>["x"]>().toEqualTypeOf<
      AppData | undefined
    >();
  });
});
