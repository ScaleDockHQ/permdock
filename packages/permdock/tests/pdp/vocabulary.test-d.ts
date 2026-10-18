import { describe, expectTypeOf, it } from "vitest";

import type { PdpPermDock } from "../../src/pdp/index.ts";
import type { PolicyVocabularyOf, roles } from "../fixtures/vocabulary.ts";

import { getPermDockSync } from "../../src/pdp/index.ts";
import { policy } from "../fixtures/vocabulary.ts";

describe("permdock/pdp vocabulary", () => {
  it("returns the instance typed by the policy vocabulary", () => {
    const permdock = getPermDockSync(policy, null);
    expectTypeOf(permdock).toEqualTypeOf<
      PdpPermDock<PolicyVocabularyOf<typeof policy>>
    >();
    expectTypeOf(permdock)
      .toHaveProperty("roles")
      .toEqualTypeOf<typeof roles>();
  });
});
