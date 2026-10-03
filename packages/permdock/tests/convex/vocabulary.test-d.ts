import { describe, expectTypeOf, it } from "vitest";

import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/convex/index.ts";
import { policy } from "../fixtures/vocabulary.ts";

type Ctx = { readonly db: unknown };

const { withPermDock } = createPermDock(policy, {
  subject: (_ctx: Ctx) => null,
});

describe("permdock/convex vocabulary", () => {
  it("types ctx.permdock by the policy vocabulary", () => {
    withPermDock((ctx) => {
      expectTypeOf(ctx.permdock).toEqualTypeOf<VocabularyPermDock>();
      expectTypeOf(ctx.permdock.roles).toEqualTypeOf<typeof roles>();
      expectTypeOf(ctx.permdock).toEqualTypeOf<PermDockOf<typeof policy>>();
      return null;
    });
  });
});
