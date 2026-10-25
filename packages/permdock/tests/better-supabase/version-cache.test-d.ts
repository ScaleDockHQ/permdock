import type { ServerOptions } from "better-supabase/server";

import { describe, expectTypeOf, it } from "vitest";

import type { VersionCache } from "../../src/index.ts";

/** better-supabase 0.15's `AuthzVersionCache`, which 0.13 does not export. */
type AuthzVersionCacheShape = {
  evict: (userId: string) => void | PromiseLike<void>;
};

type VersionsSlot = "versions" extends keyof ServerOptions
  ? ServerOptions extends { readonly versions?: infer V }
    ? NonNullable<V>
    : never
  : AuthzVersionCacheShape;

describe("memoryVersionCache with better-supabase", () => {
  it("is accepted as ServerOptions.versions, so one cache serves both", () => {
    expectTypeOf<VersionCache>().toExtend<VersionsSlot>();
    expectTypeOf<VersionCache>().toExtend<AuthzVersionCacheShape>();
  });
});
