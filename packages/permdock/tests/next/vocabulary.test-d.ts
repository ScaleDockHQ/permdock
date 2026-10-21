import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

import type { ActionResult } from "../../src/next/index.ts";
import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/next/index.ts";
import { permissions, policy } from "../fixtures/vocabulary.ts";

const { getPermDock, protectAction } = createPermDock(policy, {
  subject: () => null,
});

describe("permdock/next vocabulary", () => {
  it("types getPermDock by the policy vocabulary", async () => {
    const permdock = await getPermDock();
    expectTypeOf(permdock).toEqualTypeOf<VocabularyPermDock>();
    expectTypeOf(permdock.roles).toEqualTypeOf<typeof roles>();
    expectTypeOf(permdock).toEqualTypeOf<PermDockOf<typeof policy>>();
  });

  it("types protectAction's input, row and result", () => {
    const Input = z.object({ id: z.string() });
    const action = protectAction(permissions.post.read, {
      input: Input,
      data: (input) => ({ id: input.id, n: 1 }),
    })(async (input, { data, permdock }) => {
      expectTypeOf(input).toEqualTypeOf<{ id: string }>();
      expectTypeOf(data).toEqualTypeOf<{ id: string; n: number }>();
      expectTypeOf(permdock).toEqualTypeOf<VocabularyPermDock>();
      return data.n;
    });
    expectTypeOf(action).parameter(0).toBeUnknown();
    expectTypeOf(action).returns.resolves.toEqualTypeOf<ActionResult<number>>();
  });
});
