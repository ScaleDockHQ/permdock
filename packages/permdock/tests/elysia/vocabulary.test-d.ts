import { Elysia } from "elysia";
import { describe, expectTypeOf, it } from "vitest";

import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/elysia/index.ts";
import { policy } from "../fixtures/vocabulary.ts";

const { permdock } = createPermDock(policy, { subject: () => null });

describe("permdock/elysia vocabulary", () => {
  it("derives permdock typed by the policy vocabulary", () => {
    new Elysia().use(permdock()).get("/", (ctx) => {
      expectTypeOf(ctx.permdock).toEqualTypeOf<VocabularyPermDock>();
      expectTypeOf(ctx.permdock.roles).toEqualTypeOf<typeof roles>();
      expectTypeOf(ctx.permdock).toEqualTypeOf<PermDockOf<typeof policy>>();
      return null;
    });
  });
});
