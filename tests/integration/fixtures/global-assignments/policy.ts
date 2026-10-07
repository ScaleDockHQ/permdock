import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";

/**
 * Owners assign every tenant role. The platform admin, a global role,
 * assigns the global support role and tenant owners; nobody else assigns a
 * global role.
 */
export const permissions = definePermissions({
  job: resource({
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const { job } = permissions;

export const policy = definePolicy(permissions, {
  roles: [
    role("owner", [allow([job.read, job.update])], {
      on: "tenant",
      assigns: ["owner", "member"],
    }),
    role("member", [allow(job.read)], { on: "tenant" }),
    role("platform-admin", [allow(job.read)], {
      assigns: ["platform-support", "owner"],
    }),
    role("platform-support", [allow(job.read)]),
  ],
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
});
