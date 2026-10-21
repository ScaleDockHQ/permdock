import type { PermissionsOf, ResourceInit } from "permdock";

import { definePermissions, resource } from "permdock";
import { z } from "zod";

type Post = { readonly id: string; readonly published: boolean };

type Spec = {
  readonly post: ResourceInit<
    Post,
    readonly ["read", "update"],
    readonly ["list"]
  >;
};

const postSchema = z.object({ id: z.string(), published: z.boolean() });

export const permissions: PermissionsOf<Spec> = definePermissions({
  post: resource(postSchema, {
    actions: ["read", "update"],
    collection: ["list"],
  }),
});

export const readKey: "post.read" = permissions.post.read.key;

type Mismatched = {
  readonly post: ResourceInit<
    Post,
    readonly ["read", "delete"],
    readonly ["list"]
  >;
};

// @ts-expect-error the definition has update, not delete
export const mismatched: PermissionsOf<Mismatched> = definePermissions({
  post: resource(postSchema, {
    actions: ["read", "update"],
    collection: ["list"],
  }),
});
