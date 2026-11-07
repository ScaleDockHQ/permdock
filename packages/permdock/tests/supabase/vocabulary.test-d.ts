import { describe, expectTypeOf, it } from "vitest";

import type { PermDockOf } from "../fixtures/vocabulary.ts";

import { definePermDock } from "../../src/supabase/index.ts";
import { createPermDock } from "../../src/supabase/middleware.ts";
import { policy } from "../fixtures/vocabulary.ts";

const app = definePermDock(policy, { profile: "dev" });

describe("permdock/supabase vocabulary", () => {
  it("types every definition member by the policy vocabulary", () => {
    expectTypeOf(app.fromClaims).returns.resolves.toEqualTypeOf<
      PermDockOf<typeof policy>
    >();
    expectTypeOf(app.fromClient).returns.resolves.toEqualTypeOf<
      PermDockOf<typeof policy>
    >();
    expectTypeOf(app.getPermDock).returns.resolves.toEqualTypeOf<
      PermDockOf<typeof policy>
    >();
  });

  it("contributes ctx.permdock of the same vocabulary", () => {
    const { withPermDock } = createPermDock(app);
    expectTypeOf(withPermDock).toBeFunction();
  });
});
