import type {
  AuthorizeHookOptions,
  ProtectWebHandlerOptions,
} from "better-supabase/workflow-sdk";

import { describe, expectTypeOf, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";

import { handlerCan, hookCan } from "../../src/better-supabase/index.ts";

declare const permdock: PermDock;

describe("workflow-sdk slots", () => {
  it("fill authorizeHook's and protectWebHandler's can options", () => {
    expectTypeOf(hookCan(permdock)).toExtend<
      NonNullable<AuthorizeHookOptions["can"]>
    >();
    expectTypeOf(handlerCan({ getPermDock: () => permdock })).toExtend<
      ProtectWebHandlerOptions["can"]
    >();
  });
});
