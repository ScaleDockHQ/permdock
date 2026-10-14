import type { H3Event } from "h3";

import { describe, expectTypeOf, it } from "vitest";

import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/h3/index.ts";
import { permissions, policy } from "../fixtures/vocabulary.ts";

const { withPermDock, getPermDock, protect } = createPermDock(policy, {
  subject: () => null,
});

describe("permdock/h3 vocabulary", () => {
  it("hands handlers the instance typed by the policy vocabulary", () => {
    withPermDock((event) => {
      expectTypeOf(event.context.permdock).toEqualTypeOf<VocabularyPermDock>();
      expectTypeOf(event.context.permdock.roles).toEqualTypeOf<typeof roles>();
      expectTypeOf(event.context.permdock).toEqualTypeOf<
        PermDockOf<typeof policy>
      >();
      return null;
    });
    expectTypeOf(getPermDock).returns.resolves.toEqualTypeOf<
      PermDockOf<typeof policy>
    >();
    expectTypeOf(getPermDock).parameter(0).toEqualTypeOf<H3Event>();
    expectTypeOf(protect(permissions.post.read)).toBeFunction();
  });
});
