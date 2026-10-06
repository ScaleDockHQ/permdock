import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";

/**
 * Owners assign every tenant role, admins assign members, members assign
 * nothing. The platform admin, a global role, assigns the global support
 * role and tenant owners, and manages platform custom roles.
 */
export const permissions = definePermissions({
  job: resource({
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  member: resource({
    collection: { assignRole: { manageRoles: true } },
  }),
});

const { job, member } = permissions;

export const policy = definePolicy(permissions, {
  roles: [
    role("owner", [allow([job.read, job.update])], {
      on: "tenant",
      assigns: ["owner", "admin", "member"],
    }),
    role("admin", [allow(job.read)], { on: "tenant", assigns: ["member"] }),
    role("member", [allow(job.read)], { on: "tenant" }),
    role("platform-admin", [allow([job.read, member.assignRole])], {
      assigns: ["platform-support", "owner"],
    }),
    role("platform-support", [allow(job.read)], { assignable: true }),
  ],
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
});
