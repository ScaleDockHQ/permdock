import { definePermissions, resource } from "permdock";

export const permissions = definePermissions({
  employee: resource({
    actions: ["read"],
    parent: { field: "managerId", resource: "employee" },
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});
