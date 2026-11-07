import { describe, expectTypeOf, it } from "vitest";

import type { permissions } from "../fixtures/quick-start.ts";

import { defineBlocksConfig } from "../../src/better-supabase/index.ts";

const define = defineBlocksConfig<typeof permissions>();

describe(defineBlocksConfig, () => {
  it("returns the blocks it is given", () => {
    const blocks = define({ audit: { permissions: { read: "post.read" } } });
    expectTypeOf(blocks.audit.permissions.read).toEqualTypeOf<"post.read">();
  });

  it("refuses a key the permission tree does not hold", () => {
    define({
      // @ts-expect-error `post.archive` is not a permission of the tree.
      audit: { permissions: { read: "post.archive" } },
    });
  });
});
