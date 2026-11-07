import { definePermissions, resource } from "permdock";

export const permissions = definePermissions({
  job: resource({
    actions: ["read", "update"],
    relations: { org: { field: "organizationId", memberOf: "tenant" } },
  }),
  jobParty: resource({
    actions: ["read"],
    parent: { field: "jobId", resource: "job" },
    relations: { org: { field: "organizationId", memberOf: "tenant" } },
  }),
});
