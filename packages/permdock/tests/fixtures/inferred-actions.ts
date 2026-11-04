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

const Ticket = z.object({ id: z.string(), organization_id: z.string() });

export const permissions = definePermissions({
  ticket: resource(Ticket, {
    id: "id",
    actions: ["read", "updateStatus", "approve", "listArchived"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
});

const roles = defineRoles({
  member: { on: "organization" },
  admin: { on: "organization" },
});

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organization_id" } },
    subject: (user: Principal | null) => user,
    roles: [
      role(
        roles.member,
        [
          allow([
            permissions.ticket.read,
            permissions.ticket.updateStatus,
            permissions.ticket.approve,
            permissions.ticket.listArchived,
          ]),
        ],
        { on: "organization" },
      ),
      role(roles.admin, [allow([permissions.ticket.updateStatus])], {
        on: "organization",
      }),
    ],
  },
);
