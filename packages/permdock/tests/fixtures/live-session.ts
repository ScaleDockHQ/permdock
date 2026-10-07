import { z } from "zod";

import type { Principal } from "../../src/index.ts";

import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "../../src/index.ts";

/** Members read invoices with any token and update them only on a session the Auth server still holds. */
const Invoice = z.object({
  id: z.string(),
  organization_id: z.string(),
});

export const permissions = definePermissions({
  invoice: resource(Invoice, {
    id: "id",
    actions: ["read", "update"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
});

const roles = defineRoles({ member: { on: "organization" } });

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organization_id" } },
    subject: (user: Principal | null) => user,
    roles: [
      role(
        roles.member,
        [
          allow(permissions.invoice.read),
          allow(permissions.invoice.update, {
            where: { subject: { session: { live: true } } },
          }),
        ],
        { on: "organization" },
      ),
    ],
  },
);
