import { describe, expectTypeOf, it } from "vitest";

import type { ActionResult, ProtectedAction } from "../../src/react/index.ts";

import {
  Protected,
  useGate,
  usePermission,
  useProtectedAction,
} from "../../src/react/index.ts";
import { permissions } from "../fixtures/quick-start.ts";

describe("React row types", () => {
  it("types data on usePermission, useGate, useProtectedAction and Protected", () => {
    function Typed(): null {
      usePermission(permissions.post.update, { authorId: "u1" });
      useGate(permissions.post.update, { published: true }, { mode: "hide" });
      const body: unknown = JSON.parse("{}");
      usePermission(permissions.post.update, body);
      // @ts-expect-error published is a boolean
      usePermission(permissions.post.update, { published: "yes" });
      // @ts-expect-error authorID is not a Post field
      useGate(permissions.post.update, { authorID: "u1" });
      const save: ProtectedAction<{ readonly id: string }> = () =>
        Promise.resolve({ ok: true, value: { id: "p1" } });
      const saving = useProtectedAction(save, permissions.post.update, {
        authorId: "u1",
      });
      expectTypeOf(saving.result).toEqualTypeOf<
        ActionResult<{ readonly id: string }> | undefined
      >();
      // @ts-expect-error published is a boolean
      useProtectedAction(save, permissions.post.update, { published: "yes" });
      return null;
    }
    void Typed;
    void (
      <Protected permission={permissions.post.update} data={{ authorId: "u1" }}>
        ok
      </Protected>
    );
    void (
      <Protected
        permission={permissions.post.update}
        // @ts-expect-error published is a boolean
        data={{ published: "yes" }}
      >
        ok
      </Protected>
    );
  });
});
