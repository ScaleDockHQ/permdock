import { definePermissions, resource } from "permdock";

export const permissions = definePermissions({
  file: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});
