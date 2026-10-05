import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";

/** Owners assign every role, admins assign members, members assign nothing. */
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
      assigns: ["owner", "admin", "member"],
    }),
    role("admin", [allow(job.read)], { on: "tenant", assigns: ["member"] }),
    role("member", [allow(job.read)], { on: "tenant" }),
  ],
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
});
