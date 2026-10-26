import type { AuthzVersionCache, ServerOptions } from "better-supabase/server";

import { describe, expectTypeOf, it } from "vitest";

import type { VersionCache } from "../../src/index.ts";

describe("memoryVersionCache with better-supabase", () => {
  it("is accepted as ServerOptions.versions, so one cache serves both", () => {
    expectTypeOf<VersionCache>().toExtend<
      NonNullable<ServerOptions["versions"]>
    >();
    expectTypeOf<VersionCache>().toExtend<AuthzVersionCache>();
  });
});
