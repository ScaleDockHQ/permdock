import { definePermissions, resource } from "permdock";
import { z } from "zod";

const id = z.uuid();

export const permissions = definePermissions({
  doc: resource(
    z.object({
      id,
      folderId: id,
      ownerId: id.nullable(),
      restricted: z.boolean(),
    }),
    {
      actions: ["read", "update"],
      parent: { field: "folderId", resource: "folder" },
      relations: { owner: "ownerId" },
      restricted: "restricted",
    },
  ),
  folder: resource(
    z.object({
      id,
      parentId: id.nullable(),
      restricted: z.boolean(),
      ownerId: id.nullable(),
    }),
    {
      actions: ["read", "update"],
      parent: { field: "parentId", resource: "folder" },
      relations: {
        viewer: { edge: "folder_viewers", expiresAt: "expires_at" },
        editor: { edge: "folder_editors" },
        owner: "ownerId",
      },
      restricted: "restricted",
    },
  ),
  employee: resource(z.object({ id, managerId: id.nullable() }), {
    actions: ["read"],
    parent: { field: "managerId", resource: "employee" },
    relations: { manager: { principal: "managerId" } },
  }),
});
