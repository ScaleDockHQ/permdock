import { describe, expectTypeOf, it } from "vitest";

import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/express/index.ts";
import { policy } from "../fixtures/vocabulary.ts";

const { withPermDock } = createPermDock(policy, { subject: () => null });

describe("permdock/express vocabulary", () => {
  it("types req.permdock in withPermDock by the policy vocabulary", () => {
    withPermDock((req) => {
      expectTypeOf(req.permdock).toEqualTypeOf<VocabularyPermDock>();
      expectTypeOf(req.permdock.roles).toEqualTypeOf<typeof roles>();
      expectTypeOf(req.permdock).toEqualTypeOf<PermDockOf<typeof policy>>();
    });
  });
});
