import type { createHono } from "better-supabase/hono";
import type { createMcp } from "better-supabase/mcp";
import type {
  AnyAuthorizer,
  Authorizer,
  PermissionRef,
} from "better-supabase/server";

import { describe, expectTypeOf, it } from "vitest";

import type { authorizer } from "../../src/better-supabase/index.ts";
import type { Permission } from "../../src/core/permission-types.ts";

type PermDockAuthorizer = ReturnType<typeof authorizer>;

describe("authorizer with better-supabase's servers", () => {
  it("is an Authorizer of PermDock permissions", () => {
    expectTypeOf<PermDockAuthorizer>().toEqualTypeOf<Authorizer<Permission>>();
    expectTypeOf<PermDockAuthorizer>().toExtend<AnyAuthorizer>();
    expectTypeOf<
      PermissionRef<PermDockAuthorizer>
    >().toEqualTypeOf<Permission>();
  });

  it("is accepted by createHono and createMcp", () => {
    expectTypeOf<PermDockAuthorizer>().toExtend<
      NonNullable<NonNullable<Parameters<typeof createHono>[1]>["authorizer"]>
    >();
    expectTypeOf<PermDockAuthorizer>().toExtend<
      NonNullable<Parameters<typeof createMcp>[1]["authorizer"]>
    >();
  });
});
