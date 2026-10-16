import { describe, expectTypeOf, it } from "vitest";

import type { WorkflowPermDockOptions } from "../../src/workflow/index.ts";
import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/workflow/index.ts";
import { policy } from "../fixtures/vocabulary.ts";

declare const options: WorkflowPermDockOptions;
const { getPermDock } = createPermDock(policy, options);

describe("permdock/workflow vocabulary", () => {
  it("types getPermDock by the policy vocabulary", async () => {
    const permdock = await getPermDock("ticket");
    expectTypeOf(permdock).toEqualTypeOf<VocabularyPermDock>();
    expectTypeOf(permdock.roles).toEqualTypeOf<typeof roles>();
    expectTypeOf(permdock).toEqualTypeOf<PermDockOf<typeof policy>>();
  });
});
