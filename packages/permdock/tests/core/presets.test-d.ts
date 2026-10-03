import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { definePermissions, resource } from "../../src/core/permissions.ts";
import { crud, readable, writable } from "../../src/core/presets.ts";

const Post = z.object({ id: z.string() });

describe("preset arity", () => {
  it("keeps extra record keys and the instance/collection split", () => {
    const permissions = definePermissions({
      post: resource(
        Post,
        crud({
          id: "id",
          actions: { publish: { title: "Publish post" } },
        }),
      ),
    });
    expectTypeOf(permissions.post.publish.key).toEqualTypeOf<"post.publish">();
    expectTypeOf(permissions.post.update.kind).toEqualTypeOf<"instance">();
    expectTypeOf(permissions.post.create.kind).toEqualTypeOf<"collection">();
    expectTypeOf(permissions.post.read.kind).toEqualTypeOf<"instance">();
    expectTypeOf(permissions.post.list.kind).toEqualTypeOf<"collection">();
  });

  it("keeps extra array literals as literal keys", () => {
    const permissions = definePermissions({
      post: resource(Post, crud({ actions: ["archive"] })),
    });
    expectTypeOf(permissions.post.archive.key).toEqualTypeOf<"post.archive">();
    expectTypeOf(permissions.post.archive.kind).toEqualTypeOf<"instance">();
  });

  it("types readable and writable without extra collection on writable", () => {
    const permissions = definePermissions({
      report: resource(Post, readable()),
      setting: resource(Post, writable()),
    });
    expectTypeOf(permissions.report.read.kind).toEqualTypeOf<"instance">();
    expectTypeOf(permissions.report.list.kind).toEqualTypeOf<"collection">();
    expectTypeOf(permissions.setting.read.kind).toEqualTypeOf<"instance">();
    expectTypeOf(permissions.setting.update.kind).toEqualTypeOf<"instance">();
    expectTypeOf(permissions.setting).not.toHaveProperty("create");
    expectTypeOf(permissions.setting).not.toHaveProperty("list");
  });
});
