import { definePermissions, principal, resource } from "permdock";

export const permissions = definePermissions({
  job: resource({
    id: "id",
    actions: ["read", "create"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
    levels: { own: { ownerId: principal.id }, all: {} },
  }),
});
