import type { APIEvent } from "@solidjs/start/server";

import { describe, expectTypeOf, it } from "vitest";

import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/solid-start/index.ts";
import { ownPost } from "../fixtures/quick-start.ts";
import { permissions, policy } from "../fixtures/vocabulary.ts";

const { protect, withPermDock, getPermDock } = createPermDock(policy, {
  subject: () => null,
});

describe("permdock/solid-start vocabulary", () => {
  it("hands API routes the instance typed by the policy vocabulary", () => {
    const route = protect(
      permissions.post.update,
      () => ownPost,
    )((event) => {
      expectTypeOf(event.locals.permdock).toEqualTypeOf<VocabularyPermDock>();
      expectTypeOf(event.locals.permdock.roles).toEqualTypeOf<typeof roles>();
      expectTypeOf(event.locals.permdockData).toEqualTypeOf<typeof ownPost>();
      expectTypeOf(event.params).toEqualTypeOf<APIEvent["params"]>();
      return new Response(null);
    });
    expectTypeOf(route).parameter(0).toEqualTypeOf<APIEvent>();
    withPermDock((event) => {
      expectTypeOf(event.locals.permdock).toEqualTypeOf<
        PermDockOf<typeof policy>
      >();
      return new Response(null);
    });
    expectTypeOf(getPermDock).returns.resolves.toEqualTypeOf<
      PermDockOf<typeof policy>
    >();
  });
});
