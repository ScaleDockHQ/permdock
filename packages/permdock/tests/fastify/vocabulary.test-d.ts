import { describe, expectTypeOf, it } from "vitest";

import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/fastify/index.ts";
import { policy } from "../fixtures/vocabulary.ts";

const { withPermDock } = createPermDock(policy, { subject: () => null });

describe("permdock/fastify vocabulary", () => {
  it("types request.permdock in withPermDock by the policy vocabulary", () => {
    withPermDock<{ Params: { readonly id: string } }>((request) => {
      expectTypeOf(request.params.id).toEqualTypeOf<string>();
      expectTypeOf(request.permdock).toEqualTypeOf<VocabularyPermDock>();
      expectTypeOf(request.permdock.roles).toEqualTypeOf<typeof roles>();
      expectTypeOf(request.permdock).toEqualTypeOf<PermDockOf<typeof policy>>();
    });
  });
});
