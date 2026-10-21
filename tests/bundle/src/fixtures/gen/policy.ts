import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "permdock";

const permissions = definePermissions({
  project: resource({
    actions: ["read", "update"],
    relations: { org: { field: "organizationId", memberOf: "organization" } },
  }),
});
const roles = defineRoles({ admin: { on: "organization", assignable: true } });

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organizationId" } },
    roles: [role(roles.admin, [allow(permissions.project.update)])],
    subject: () => null,
  },
);
