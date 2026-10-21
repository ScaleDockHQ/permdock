import { defineOperations } from "permdock";
import { z } from "zod";

import { ownPost, permissions } from "./permissions.ts";

export const postRef = z.object({ id: z.string() });

export const operations = defineOperations(permissions, {
  "posts.read": {
    permission: permissions.post.read,
    data: (input: { readonly id: string }) =>
      input.id === ownPost.id ? ownPost : null,
    meta: { title: "Read a post", effects: ["read"] },
  },
  "posts.list": {
    permission: permissions.post.list,
    meta: { title: "List posts", effects: ["read"] },
  },
});
