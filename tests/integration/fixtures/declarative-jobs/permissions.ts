import { definePermissions, principal, resource, sqlFunction } from "permdock";
import { z } from "zod";

const Job = z.object({
  id: z.string(),
  organization_id: z.string(),
  owner_id: z.string(),
  team_id: z.string(),
});

/**
 * The team level reads the caller's teams from the database or, on the device,
 * the `team_ids` claim.
 */
const inTeam = sqlFunction("private.is_team_member", {
  args: [{ field: "owner_id" }, { field: "team_id" }],
  twin: {
    or: [
      { owner_id: principal.id },
      { team_id: { in: { ref: "principal.claims.team_ids" } } },
    ],
  },
});

export const permissions = definePermissions({
  jobs: resource(Job, {
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "organization_id", memberOf: "tenant" } },
    levels: { own: { owner_id: principal.id }, team: inTeam, all: {} },
  }),
  /**
   * A holder of `platformRole.manage` through a global role writes custom roles
   * in any tenant.
   */
  platformRole: resource({ collection: { manage: { manageRoles: true } } }),
  jobParty: resource({
    actions: ["read"],
    parent: { field: "job_id", resource: "jobs" },
    relations: { org: { field: "organization_id", memberOf: "tenant" } },
  }),
});
