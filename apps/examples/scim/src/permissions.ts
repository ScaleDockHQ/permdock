import { definePermissions, resource } from "permdock";
import { z } from "zod";

export const Post = z.object({
  id: z.string(),
  orgId: z.string(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: "id",
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

export const samplePost = {
  id: "p1",
  orgId: "o_acme",
};
