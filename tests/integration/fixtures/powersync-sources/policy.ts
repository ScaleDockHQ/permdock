import {
  allow,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
  sqlFunction,
} from "permdock";
import { z } from "zod";

/**
 * A CentraKit-shaped app: a plan tier on `tenant_users` grants `owner`
 * through a generated `tier_role` column, `user_roles` assigns roles from
 * `roles` (declared or a tenant's custom roles), and a custom role picks the
 * own, team or all level of `job.read`. The team level is a database
 * function with a portable twin.
 */
export const permissions = definePermissions({
  job: resource(
    z.object({
      id: z.string(),
      tenant_id: z.string(),
      owner_id: z.string(),
      team_id: z.string(),
    }),
    {
      id: "id",
      actions: ["read", "update"],
      relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
      levels: {
        own: { owner_id: principal.id },
        team: sqlFunction("permdock_in_team", {
          args: [{ field: "team_id" }],
          twin: { team_id: { in: { ref: "principal.claims.team_ids" } } },
        }),
        all: {},
      },
    },
  ),
});

const { job } = permissions;

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "tenant_id" } },
  subject: () => null,
  roles: [
    role("owner", [allow([job.read, job.update])], {
      on: "tenant",
      assignable: true,
    }),
  ],
});
