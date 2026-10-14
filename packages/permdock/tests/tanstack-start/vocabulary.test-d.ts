import { createMiddleware } from "@tanstack/react-start";
import { describe, expectTypeOf, it } from "vitest";

import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/tanstack-start/index.ts";
import { ownPost } from "../fixtures/quick-start.ts";
import { permissions, policy } from "../fixtures/vocabulary.ts";

const { middleware, protect, getPermDock } = createPermDock(policy, {
  subject: () => null,
});

describe("permdock/tanstack-start vocabulary", () => {
  it("adds the instance typed by the policy vocabulary to the server context", () => {
    createMiddleware()
      .middleware([middleware()])
      .server(({ context, next }) => {
        expectTypeOf(context.permdock).toEqualTypeOf<VocabularyPermDock>();
        expectTypeOf(context.permdock.roles).toEqualTypeOf<typeof roles>();
        return next();
      });
    createMiddleware()
      .middleware([protect(permissions.post.update, () => ownPost)])
      .server(({ context, next }) => {
        expectTypeOf(context.permdock).toEqualTypeOf<
          PermDockOf<typeof policy>
        >();
        expectTypeOf(context.permdockData).toEqualTypeOf<typeof ownPost>();
        return next();
      });
    expectTypeOf(getPermDock).returns.resolves.toEqualTypeOf<
      PermDockOf<typeof policy>
    >();
  });
});
