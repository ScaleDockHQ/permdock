import { crud, definePermissions, resource } from "permdock";
import { z } from "zod";

export const Post = z.object({
  id: z.string(),
  orgId: z.string(),
  authorId: z.string(),
});

export const permissions = definePermissions({
  post: resource(
    Post,
    crud({ relations: { org: { field: "orgId", memberOf: "tenant" } } }),
  ),
});
