import { describe, expectTypeOf, it } from "vitest";

import type { DeliveryPermDockOptions } from "../../src/delivery/index.ts";
import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/delivery/index.ts";
import { policy } from "../fixtures/vocabulary.ts";

declare const options: DeliveryPermDockOptions;
const { deliver } = createPermDock(policy, options);

describe("permdock/delivery vocabulary", () => {
  it("takes the instance typed by the policy vocabulary", () => {
    expectTypeOf(deliver).parameter(0).toEqualTypeOf<VocabularyPermDock>();
    expectTypeOf(deliver)
      .parameter(0)
      .toEqualTypeOf<PermDockOf<typeof policy>>();
    expectTypeOf<VocabularyPermDock["roles"]>().toEqualTypeOf<typeof roles>();
  });
});
