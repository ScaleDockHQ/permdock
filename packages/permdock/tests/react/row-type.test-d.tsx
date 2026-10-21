import { describe, it } from "vitest";

import { Protected, useGate, usePermission } from "../../src/react/index.ts";
import { permissions } from "../fixtures/quick-start.ts";

describe("React row types", () => {
  it("types data on usePermission, useGate and Protected", () => {
    function Typed(): null {
      usePermission(permissions.post.update, { authorId: "u1" });
      useGate(permissions.post.update, { published: true }, { mode: "hide" });
      const body: unknown = JSON.parse("{}");
      usePermission(permissions.post.update, body);
      // @ts-expect-error published is a boolean
      usePermission(permissions.post.update, { published: "yes" });
      // @ts-expect-error authorID is not a Post field
      useGate(permissions.post.update, { authorID: "u1" });
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
