import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  deny,
  resource,
  role,
} from "permdock";
import { z } from "zod";

const File = z.object({ id: z.uuid(), organization_id: z.uuid() });
const Report = z.object({ id: z.uuid(), organization_id: z.uuid() });

const organization = {
  organization: { field: "organization_id", memberOf: "tenant" },
} as const;

export const permissions = definePermissions({
  files: resource(File, {
    id: "id",
    actions: ["read", "update"],
    relations: organization,
  }),
  reports: resource(Report, {
    id: "id",
    actions: ["read"],
    relations: organization,
  }),
});

export const roles = defineRoles({
  admin: { on: "tenant" },
  reader: { on: "tenant" },
  blocked: { on: "tenant" },
  staff: { assignable: true },
  auditor: { assignable: true },
  suspended: {},
});

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { tenant: { key: "organization_id" } },
    subject: () => null,
    roles: [
      role(
        roles.admin,
        [
          allow([
            permissions.files.read,
            permissions.files.update,
            permissions.reports.read,
          ]),
        ],
        { on: "tenant" },
      ),
      role(roles.reader, [allow(permissions.files.read)], { on: "tenant" }),
      role(roles.blocked, [deny(permissions.files.read)], { on: "tenant" }),
      role(roles.staff, [allow(permissions.files.read)]),
      role(roles.auditor, [allow(permissions.reports.read)]),
      role(roles.suspended, [deny(permissions.files.read)]),
    ],
  },
);
