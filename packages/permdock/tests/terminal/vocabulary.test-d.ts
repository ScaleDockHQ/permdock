import { describe, expectTypeOf, it } from "vitest";

import type { PermDockOf, VocabularyPermDock } from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/terminal/index.ts";
import { permissions, policy } from "../fixtures/vocabulary.ts";

const { permdock, protect } = createPermDock(policy, { subject: () => null });

describe("permdock/terminal vocabulary", () => {
  it("types the instance and the protect context by the policy vocabulary", () => {
    expectTypeOf(permdock).returns.resolves.toEqualTypeOf<VocabularyPermDock>();
    protect(permissions.post.read)((context) => {
      expectTypeOf(context.permdock).toEqualTypeOf<PermDockOf<typeof policy>>();
    });
  });
});
