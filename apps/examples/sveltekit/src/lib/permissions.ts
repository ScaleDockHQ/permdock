import { definePermissions, resource } from "permdock";
import { z } from "zod";

export const Post = z.object({
  id: z.string(),
  authorId: z.string(),
  orgId: z.string(),
  published: z.boolean(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: "id",
    actions: ["read", "update", "delete", "publish"],
    collection: ["create", "list"],
  }),
});

export const ownPost = {
  id: "p1",
  authorId: "u1",
  orgId: "o1",
  published: false,
};
