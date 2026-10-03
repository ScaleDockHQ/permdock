import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Permission } from "../../src/core/permissions.ts";

import {
  definePermissions,
  getResource,
  listPermissions,
  resource,
} from "../../src/core/permissions.ts";
import { crud, readable, writable } from "../../src/core/presets.ts";

const Post = z.object({ id: z.string(), authorId: z.string() });
const Comment = z.object({ id: z.string(), postId: z.string() });
const Report = z.object({ id: z.string() });
const Setting = z.object({ id: z.string() });

function shapes(leaves: readonly Permission[]) {
  return leaves
    .map((leaf) => ({
      key: leaf.key,
      kind: leaf.kind,
      meta: { ...leaf.meta },
    }))
    .toSorted((left, right) => left.key.localeCompare(right.key));
}

describe("presets", () => {
  it("matches a handwritten CRUD resource on keys, kind and meta", () => {
    const fromPreset = definePermissions({
      post: resource(Post, crud({ id: "id" })),
    });
    const handwritten = definePermissions({
      post: resource(Post, {
        id: "id",
        actions: {
          read: { readOnly: true },
          update: {},
          delete: { destructive: true },
        },
        collection: {
          create: {},
          list: { readOnly: true },
        },
      }),
    });
    expect(shapes(listPermissions(fromPreset))).toEqual(
      shapes(listPermissions(handwritten)),
    );
  });

  it("merges extra actions onto the preset records", () => {
    const fromPreset = definePermissions({
      post: resource(
        Post,
        crud({
          id: "id",
          actions: { publish: { title: "Publish post" } },
        }),
      ),
    });
    const handwritten = definePermissions({
      post: resource(Post, {
        id: "id",
        actions: {
          read: { readOnly: true },
          update: {},
          delete: { destructive: true },
          publish: { title: "Publish post" },
        },
        collection: {
          create: {},
          list: { readOnly: true },
        },
      }),
    });
    expect(shapes(listPermissions(fromPreset))).toEqual(
      shapes(listPermissions(handwritten)),
    );
    expect(fromPreset.post.publish.kind).toBe("instance");
    expect(fromPreset.post.publish.meta).toEqual({ title: "Publish post" });
  });

  it("overlays extra meta onto defaults without dropping unread fields", () => {
    const permissions = definePermissions({
      post: resource(
        Post,
        crud({
          actions: {
            read: { title: "Read post" },
            delete: { title: "Delete post" },
          },
        }),
      ),
    });
    expect(permissions.post.read.meta).toEqual({
      title: "Read post",
      readOnly: true,
    });
    expect(permissions.post.delete.meta).toEqual({
      title: "Delete post",
      destructive: true,
    });
  });

  it("lets extra meta win when it sets a default field", () => {
    const permissions = definePermissions({
      post: resource(
        Post,
        crud({
          actions: {
            read: { readOnly: false },
            delete: { destructive: false },
          },
        }),
      ),
    });
    expect(permissions.post.read.meta).toEqual({ readOnly: false });
    expect(permissions.post.delete.meta).toEqual({ destructive: false });
  });

  it("passes id and parent through to the resource node", () => {
    const permissions = definePermissions({
      post: resource(Post, crud({ id: "id" })),
      comment: resource(
        Comment,
        crud({
          id: "id",
          parent: { field: "postId", resource: "post" },
        }),
      ),
    });
    expect(getResource(permissions, "post")?.id).toBe("id");
    expect(getResource(permissions, "comment")?.parent).toEqual({
      field: "postId",
      resource: "post",
    });
  });

  it("builds readable as read and list, both readOnly", () => {
    const permissions = definePermissions({
      report: resource(Report, readable({ id: "id" })),
    });
    expect(shapes(listPermissions(permissions))).toEqual([
      { key: "report.list", kind: "collection", meta: { readOnly: true } },
      { key: "report.read", kind: "instance", meta: { readOnly: true } },
    ]);
  });

  it("builds writable as read and update with no collection", () => {
    const permissions = definePermissions({
      setting: resource(Setting, writable({ id: "id" })),
    });
    expect(shapes(listPermissions(permissions))).toEqual([
      { key: "setting.read", kind: "instance", meta: { readOnly: true } },
      { key: "setting.update", kind: "instance", meta: {} },
    ]);
  });

  it("accepts schema-less resource(readable())", () => {
    const permissions = definePermissions({
      report: resource(readable()),
    });
    expect(permissions.report.read.kind).toBe("instance");
    expect(permissions.report.list.kind).toBe("collection");
    expect(getResource(permissions, "report")?.schema).toBeUndefined();
  });

  it("merges array extras into empty-meta records", () => {
    const permissions = definePermissions({
      post: resource(Post, crud({ actions: ["publish"] })),
    });
    expect(permissions.post.publish.meta).toEqual({});
    expect(permissions.post.read.meta).toEqual({ readOnly: true });
  });

  it("leaves instance/collection collisions for resource() to reject", () => {
    expect(() =>
      definePermissions({
        post: resource(Post, crud({ collection: ["read"] })),
      }),
    ).toThrow(/duplicate action 'read'/);
  });
});
