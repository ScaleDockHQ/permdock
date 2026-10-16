import { describe, expectTypeOf, it } from "vitest";

import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/server/index.ts";
import { policy } from "../fixtures/vocabulary.ts";

const { getPermDock } = createPermDock(policy, { subject: () => null });

describe("permdock/server vocabulary", () => {
  it("types getPermDock by the policy vocabulary", async () => {
    const permdock = await getPermDock(new Request("https://app.test/"));
    expectTypeOf(permdock).toEqualTypeOf<VocabularyPermDock>();
    expectTypeOf(permdock.roles).toEqualTypeOf<typeof roles>();
    expectTypeOf(permdock).toEqualTypeOf<PermDockOf<typeof policy>>();
  });
});
