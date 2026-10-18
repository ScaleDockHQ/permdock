import { definePermissions, resource } from "permdock";

export const permissions = definePermissions({
  task: resource({
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});
