import { describe, expectTypeOf, it } from "vitest";

import type { PermDock } from "../../src/index.ts";

import {
  authorizationHooks,
  permdockFor,
} from "../../src/better-supabase/index.ts";
import { policy } from "../fixtures/saas.ts";

describe("permdockFor vocabulary", () => {
  it("keeps the policy's vocabulary on the instance", () => {
    const resolve = permdockFor({ policy });
    expectTypeOf(resolve).returns.resolves.toExtend<PermDock>();
    expectTypeOf(resolve).returns.resolves.not.toEqualTypeOf<PermDock>();
  });

  it("is accepted where an adapter takes a permdockFor", () => {
    const resolve = permdockFor({ policy });
    expectTypeOf(authorizationHooks).parameter(0).toHaveProperty("permdockFor");
    expectTypeOf(resolve).toExtend<
      NonNullable<Parameters<typeof authorizationHooks>[0]["permdockFor"]>
    >();
  });
});
