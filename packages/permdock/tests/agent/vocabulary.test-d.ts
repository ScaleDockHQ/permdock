import { describe, expectTypeOf, it } from "vitest";

import type {
  PermDockOf,
  VocabularyPermDock,
  roles,
} from "../fixtures/vocabulary.ts";
import type { User } from "../fixtures/vocabulary.ts";

import { createPermDock } from "../../src/agent/index.ts";
import { defineOperations } from "../../src/index.ts";
import { permissions, policy } from "../fixtures/vocabulary.ts";

type Context = { readonly user: User | null };

const { getPermDock } = createPermDock(policy, {
  subject: (context: Context) => context.user,
  operations: defineOperations(permissions, {
    readPost: { permission: permissions.post.read },
  }),
});

describe("permdock/agent vocabulary", () => {
  it("types getPermDock by the policy vocabulary", async () => {
    const permdock = await getPermDock({ user: null });
    expectTypeOf(permdock).toEqualTypeOf<VocabularyPermDock>();
    expectTypeOf(permdock.roles).toEqualTypeOf<typeof roles>();
    expectTypeOf(permdock).toEqualTypeOf<PermDockOf<typeof policy>>();
  });
});
