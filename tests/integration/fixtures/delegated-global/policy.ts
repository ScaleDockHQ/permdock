import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";

export const permissions = definePermissions({
  report: resource({
    id: "id",
    actions: { read: {} },
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const { report } = permissions;

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("admin", [allow(report.read)]),
    role("member", [allow(report.read)], { on: "tenant" }),
  ],
  subject: () => null,
});
