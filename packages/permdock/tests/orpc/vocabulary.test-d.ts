import { describe, expectTypeOf, it } from "vitest";

import type { OrpcMiddlewareOpts } from "../../src/orpc/index.ts";
import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/orpc/index.ts";
import { policy } from "../fixtures/vocabulary.ts";

const { getPermDock } = createPermDock(policy, { subject: () => null });
declare const opts: OrpcMiddlewareOpts;

describe("permdock/orpc vocabulary", () => {
  it("types getPermDock by the policy vocabulary", async () => {
    const permdock = await getPermDock(opts);
    expectTypeOf(permdock).toEqualTypeOf<VocabularyPermDock>();
    expectTypeOf(permdock.roles).toEqualTypeOf<typeof roles>();
    expectTypeOf(permdock).toEqualTypeOf<PermDockOf<typeof policy>>();
  });
});
