import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

import type {
  InferPermissionTree,
  ResourceInit,
} from "../../src/core/permission-types.ts";

import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";

const Post = z.object({ id: z.string() });

const post = resource(Post, {
  actions: ["read", "update"],
  collection: ["create"],
});

type PostInit = typeof post;

describe("InferPermissionTree", () => {
  it("prefixes nested keys while it distributes over the input", () => {
    type Tree = InferPermissionTree<{
      blog: { post: PostInit };
      draft: PostInit;
    }>;
    expectTypeOf<
      Tree["blog"]["post"]["update"]["key"]
    >().toEqualTypeOf<"blog.post.update">();
    expectTypeOf<
      Tree["blog"]["post"]["create"]["kind"]
    >().toEqualTypeOf<"collection">();
    expectTypeOf<Tree["draft"]["read"]["key"]>().toEqualTypeOf<"draft.read">();
  });

  it("distributes a union input into a union of trees", () => {
    type Tree = InferPermissionTree<{ post: PostInit } | { page: PostInit }>;
    expectTypeOf<
      Extract<Tree, { post: unknown }>["post"]["read"]["key"]
    >().toEqualTypeOf<"post.read">();
    expectTypeOf<
      Extract<Tree, { page: unknown }>["page"]["read"]["key"]
    >().toEqualTypeOf<"page.read">();
  });

  it("keeps a resource at the root under the prefix it is given", () => {
    type Leaves = InferPermissionTree<PostInit, "post">;
    expectTypeOf<Leaves["update"]["key"]>().toEqualTypeOf<"post.update">();
    expectTypeOf<PostInit>().toExtend<ResourceInit>();
  });

  it("matches what definePermissions returns", () => {
    const permissions = definePermissions({ blog: { post } });
    expectTypeOf(
      permissions.blog.post.update.key,
    ).toEqualTypeOf<"blog.post.update">();
  });
});
