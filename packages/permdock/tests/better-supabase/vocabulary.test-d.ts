import { describe, expectTypeOf, it } from "vitest";

import type { PermDockResolver } from "../../src/better-supabase/permdock-for.ts";
import type { PermDock } from "../../src/index.ts";
import type { PermDockOf, VocabularyPermDock } from "../fixtures/vocabulary.ts";

import {
  authorizationHooks,
  authorizer,
  permdockFor,
} from "../../src/better-supabase/index.ts";
import { policy } from "../fixtures/vocabulary.ts";

describe("permdock/better-supabase vocabulary", () => {
  it("types permdockFor by the policy vocabulary", () => {
    const resolve = permdockFor({ policy });
    expectTypeOf(resolve).returns.resolves.toEqualTypeOf<VocabularyPermDock>();
    expectTypeOf(resolve).returns.resolves.toEqualTypeOf<
      PermDockOf<typeof policy>
    >();
  });

  it("accepts a typed permdockFor next to its policy", () => {
    const resolve = permdockFor({ policy });
    authorizer({ policy, permdockFor: resolve });
    authorizationHooks({ policy, permdockFor: resolve, claims: () => null });
  });

  it("keeps the resolver an adapter builds over V", () => {
    expectTypeOf<PermDockResolver>().returns.resolves.toEqualTypeOf<PermDock>();
    expectTypeOf<
      PermDockResolver<VocabularyPermDock extends PermDock<infer V> ? V : never>
    >().returns.resolves.toEqualTypeOf<VocabularyPermDock>();
  });

  it("rejects a permdockFor of another vocabulary", () => {
    const other = permdockFor({ policy });
    // @ts-expect-error the policy's vocabulary is the unrefined default
    authorizer<{ permissions: { readonly nope: true } }>({
      policy,
      permdockFor: other,
    });
  });
});
