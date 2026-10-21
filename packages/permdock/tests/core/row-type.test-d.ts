import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

import type { Permission, RowOf } from "../../src/index.ts";

import {
  allow,
  definePermissions,
  definePolicy,
  getPermDockSync,
  resource,
  role,
} from "../../src/index.ts";

const Post = z.object({
  id: z.string(),
  authorId: z.string(),
  views: z.number(),
});
type PostRow = z.infer<typeof Post>;
const permissions = definePermissions({
  post: resource(Post, { id: "id", actions: ["read", "update"] }),
  note: resource({ id: "id", actions: ["read"] }),
});
const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.post.read),
      allow(permissions.note.read),
    ]),
  ],
  subject: (user: { readonly id: string }) => ({
    id: user.id,
    roles: ["member"],
  }),
});
const permdock = getPermDockSync(policy, { id: "u1" });

describe("row type on Permission", () => {
  it("reads the row type of a schema resource", () => {
    expectTypeOf<
      RowOf<typeof permissions.post.update>
    >().toEqualTypeOf<PostRow>();
    expectTypeOf<RowOf<typeof permissions.note.read>>().toBeUnknown();
    expectTypeOf<RowOf<Permission>>().toBeUnknown();
  });

  it("keeps a typed leaf assignable to Permission", () => {
    expectTypeOf(permissions.post.update).toExtend<Permission>();
    const leaves: readonly Permission[] = [
      permissions.post.update,
      permissions.note.read,
    ];
    expectTypeOf(leaves).toExtend<readonly Permission[]>();
  });

  it("types data on can, decide, assert, explain and decideEach", () => {
    permdock.can(permissions.post.update, { authorId: "u1" });
    permdock.can(permissions.post.update, {
      current: { authorId: "u1" },
      next: { authorId: "u2" },
    });
    permdock.decide(permissions.post.update, { id: "p1", views: 3 });
    // @ts-expect-error views is a number
    permdock.can(permissions.post.update, { views: "3" });
    // @ts-expect-error authorID is not a Post field
    permdock.decide(permissions.post.update, { authorID: "u1" });
    // @ts-expect-error views is a number
    permdock.assert(permissions.post.update, { views: "3" });
    // @ts-expect-error views is a number
    permdock.explain(permissions.post.update, { views: "3" });
    // @ts-expect-error views is a number
    permdock.decideEach(permissions.post.update, [{ views: "3" }]);
  });

  it("takes data of no known type and any data for an untyped resource", () => {
    const body: unknown = JSON.parse("{}");
    permdock.can(permissions.post.update, body);
    permdock.decideEach(permissions.post.update, [body]);
    permdock.can(permissions.note.read, { anything: 1 });
    const runtime: Permission = permissions.post.update;
    permdock.can(runtime, { views: "3" });
  });
});
