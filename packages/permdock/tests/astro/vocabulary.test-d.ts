import type { APIContext } from "astro";

import { describe, expectTypeOf, it } from "vitest";

import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/astro/index.ts";
import { ownPost } from "../fixtures/quick-start.ts";
import { permissions, policy } from "../fixtures/vocabulary.ts";

const { protect, withPermDock } = createPermDock(policy, {
  subject: () => null,
});

describe("permdock/astro vocabulary", () => {
  it("hands endpoints the instance typed by the policy vocabulary", () => {
    const endpoint = protect(
      permissions.post.update,
      () => ownPost,
    )((context) => {
      expectTypeOf(context.locals.permdock).toEqualTypeOf<VocabularyPermDock>();
      expectTypeOf(context.locals.permdock.roles).toEqualTypeOf<typeof roles>();
      expectTypeOf(context.locals.permdockData).toEqualTypeOf<typeof ownPost>();
      return new Response(null);
    });
    expectTypeOf(endpoint).parameter(0).toExtend<APIContext>();
    withPermDock((context) => {
      expectTypeOf(context.locals.permdock).toEqualTypeOf<
        PermDockOf<typeof policy>
      >();
      return new Response(null);
    });
  });
});
