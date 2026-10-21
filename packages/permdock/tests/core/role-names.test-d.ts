import { describe, expectTypeOf, it } from "vitest";

import type { RoleNameOf } from "../../src/index.ts";
import type { policy as untyped } from "../fixtures/quick-start.ts";

import { allow, isRoleName } from "../../src/index.ts";
import { permissions as postPermissions } from "../fixtures/quick-start.ts";
import { policy } from "../fixtures/vocabulary.ts";

describe(isRoleName, () => {
  it("narrows to the role names of a defineRoles vocabulary", () => {
    expectTypeOf<RoleNameOf<typeof policy>>().toEqualTypeOf<
      "editor" | "viewer"
    >();
    const value: unknown = "editor";
    if (isRoleName(policy, value)) {
      expectTypeOf(value).toEqualTypeOf<"editor" | "viewer">();
    }
  });

  it("narrows to string when roles are declared by name only", () => {
    expectTypeOf<RoleNameOf<typeof untyped>>().toEqualTypeOf<string>();
  });
});

describe(allow, () => {
  it("takes a resource, a list of resources or the whole tree, without a condition", () => {
    expectTypeOf(allow).toBeCallableWith(postPermissions.post);
    expectTypeOf(allow).toBeCallableWith(postPermissions);
    expectTypeOf(allow).toBeCallableWith([
      postPermissions.post,
      postPermissions.post.read,
    ]);
    // @ts-expect-error a resource-wide grant carries no condition
    allow(postPermissions.post, { where: { authorId: "u1" } });
  });
});
