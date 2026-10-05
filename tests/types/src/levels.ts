import type { CustomRole, CustomRoleDropReason } from "permdock";

import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
  validateCustomRole,
} from "permdock";

export const jobs = definePermissions({
  job: resource({
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
    levels: {
      own: { ownerId: principal.id },
      team: { teamId: { in: principal["teamIds"] } },
      all: {},
    },
  }),
});

export const jobPolicy = definePolicy(jobs, {
  roles: [
    role("admin", [allow([jobs.job.read, jobs.job.update])], { on: "tenant" }),
  ],
  scopes: { tenant: { key: "orgId" } },
  subject: (user: { readonly id: string } | null) => user,
});

const dispatcher: CustomRole = {
  tenant: "acme",
  name: "dispatcher",
  grants: [{ permission: "job.read", level: "team" }],
};

export const dropReason: CustomRoleDropReason = "unknown-level";

export async function levels(): Promise<readonly string[]> {
  const result = validateCustomRole(jobPolicy, dispatcher);
  const permdock = await createPermDock(jobPolicy, { id: "u1" });
  return result.ok ? permdock.assignableLevels(jobs.job.read) : [];
}
