import { describe, expectTypeOf, it } from "vitest";

import type { DenialReason } from "../../src/index.ts";
import type {
  NextPermDockOptions,
  NextPermDockProviderProps,
} from "../../src/next/index.ts";
import type { PermDockProviderProps } from "../../src/react/index.ts";

describe("endpoint: false", () => {
  it("accepts a path or false on the factory and both providers", () => {
    expectTypeOf<NextPermDockOptions["endpoint"]>().toEqualTypeOf<
      string | false | undefined
    >();
    expectTypeOf<NextPermDockProviderProps["endpoint"]>().toEqualTypeOf<
      string | false | undefined
    >();
    expectTypeOf<PermDockProviderProps["endpoint"]>().toEqualTypeOf<
      string | false | undefined
    >();
    expectTypeOf<true>().not.toExtend<NextPermDockOptions["endpoint"]>();
  });

  it("adds server-only to the closed denial reasons", () => {
    expectTypeOf<"server-only">().toExtend<DenialReason>();
  });
});
