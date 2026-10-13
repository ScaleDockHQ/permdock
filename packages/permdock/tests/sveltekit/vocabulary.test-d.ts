import type { RequestEvent } from "@sveltejs/kit";

import { describe, expectTypeOf, it } from "vitest";

import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/sveltekit/index.ts";
import { ownPost } from "../fixtures/quick-start.ts";
import { permissions, policy } from "../fixtures/vocabulary.ts";

const { protect, withPermDock } = createPermDock(policy, {
  subject: () => null,
});

describe("permdock/sveltekit vocabulary", () => {
  it("hands handlers the instance typed by the policy vocabulary", () => {
    const handler = protect(
      permissions.post.update,
      () => ownPost,
    )((event) => {
      expectTypeOf(event.locals.permdock).toEqualTypeOf<VocabularyPermDock>();
      expectTypeOf(event.locals.permdock.roles).toEqualTypeOf<typeof roles>();
      expectTypeOf(event.locals.permdockData).toEqualTypeOf<typeof ownPost>();
      return new Response(null);
    });
    expectTypeOf(handler).parameter(0).toExtend<RequestEvent>();
    withPermDock((event) => {
      expectTypeOf(event.locals.permdock).toEqualTypeOf<
        PermDockOf<typeof policy>
      >();
      return new Response(null);
    });
  });
});
