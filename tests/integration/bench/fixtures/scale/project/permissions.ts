import { definePermissions, resource } from "permdock";
import { z } from "zod";

const id = z.uuid();

/**
 * Every shape the scale audit measures: tenant rows, a folder tree with edges
 * and a closure table, documents that follow a folder, a nested thread and
 * message chain, and a self-parented employee walk.
 */
export const permissions = definePermissions({
  item: resource(z.object({ id, orgId: id, ownerId: id }), {
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  thread: resource(z.object({ id, orgId: id }), {
    id: "id",
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  message: resource(z.object({ id, orgId: id, threadId: id }), {
    id: "id",
    actions: ["read"],
    parent: { field: "threadId", resource: "thread" },
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
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
  employee: resource(z.object({ id, orgId: id, managerId: id.nullable() }), {
    actions: ["read"],
    parent: { field: "managerId", resource: "employee" },
    relations: {
      manager: { principal: "managerId" },
      org: { field: "orgId", memberOf: "tenant" },
    },
  }),
});
