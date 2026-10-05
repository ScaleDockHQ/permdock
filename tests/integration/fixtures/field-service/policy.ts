import {
  allow,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
} from "permdock";
import { z } from "zod";

/**
 * A field-service app: organizations hold jobs and customers. A member's
 * plan tier and their organization role both grant roles, platform staff
 * hold global roles, and a tenant's custom roles pick an own, team or all
 * level of each job permission.
 */
export const permissions = definePermissions({
  job: resource(
    z.object({
      id: z.string(),
      organization_id: z.string(),
      assignee_id: z.string(),
      team_id: z.string(),
    }),
    {
      id: "id",
      actions: ["read", "update"],
      relations: {
        organization: { field: "organization_id", memberOf: "organization" },
      },
      levels: {
        own: { assignee_id: principal.id },
        team: { team_id: { in: { ref: "principal.claims.team_ids" } } },
        all: {},
      },
    },
  ),
  customer: resource(
    z.object({ id: z.string(), organization_id: z.string() }),
    {
      id: "id",
      actions: ["read"],
      relations: {
        organization: { field: "organization_id", memberOf: "organization" },
      },
    },
  ),
});

const { customer, job } = permissions;

export const policy = definePolicy(permissions, {
  scopes: { organization: { key: "organization_id" } },
  subject: () => null,
  roles: [
    role("admin", [allow([job.read, job.update, customer.read])], {
      on: "organization",
    }),
    role(
      "technician",
      [
        allow(job.read, { where: { assignee_id: principal.id } }),
        allow(job.update, { where: { assignee_id: principal.id } }),
      ],
      { on: "organization" },
    ),
    role("pro", [allow(customer.read)], { on: "organization" }),
    role("support", [allow([job.read, customer.read])]),
  ],
});
