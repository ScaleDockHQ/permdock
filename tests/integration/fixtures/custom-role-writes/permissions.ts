import { definePermissions, principal, resource } from "permdock";

export const permissions = definePermissions(
  {
    job: resource({
      id: "id",
      actions: ["read", "update"],
      relations: { org: { field: "orgId", memberOf: "tenant" } },
      levels: { own: { ownerId: principal.id }, all: {} },
    }),
    member: resource({
      collection: { assignRole: { manageRoles: true } },
    }),
  },
  { renamed: { "task.read": "job.read" } },
);
