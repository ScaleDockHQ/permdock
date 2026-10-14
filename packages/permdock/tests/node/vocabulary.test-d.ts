import { describe, expectTypeOf, it } from "vitest";

import type { PermDockOf, VocabularyPermDock } from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/node/index.ts";
import { policy } from "../fixtures/vocabulary.ts";

const { getPermDock } = createPermDock(policy, { subject: () => null });

describe("permdock/node vocabulary", () => {
  it("resolves the instance typed by the policy vocabulary", () => {
    expectTypeOf(
      getPermDock,
    ).returns.resolves.toEqualTypeOf<VocabularyPermDock>();
    expectTypeOf(getPermDock).returns.resolves.toEqualTypeOf<
      PermDockOf<typeof policy>
    >();
  });
});
