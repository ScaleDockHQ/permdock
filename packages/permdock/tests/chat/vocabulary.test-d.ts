import { describe, expectTypeOf, it } from "vitest";

import type { ChatPermDockOptions } from "../../src/chat/index.ts";
import type { Operation } from "../../src/index.ts";
import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/chat/index.ts";
import { policy } from "../fixtures/vocabulary.ts";

declare const options: ChatPermDockOptions;
declare const operation: Operation;
const { getPermDock, protect } = createPermDock(policy, options);

describe("permdock/chat vocabulary", () => {
  it("types getPermDock and the command context by the policy vocabulary", async () => {
    const permdock = await getPermDock(null);
    expectTypeOf(permdock).toEqualTypeOf<VocabularyPermDock>();
    expectTypeOf(permdock.roles).toEqualTypeOf<typeof roles>();
    expectTypeOf(permdock).toEqualTypeOf<PermDockOf<typeof policy>>();
    protect(operation, (context) => {
      expectTypeOf(context.permdock).toEqualTypeOf<VocabularyPermDock>();
    });
  });
});
