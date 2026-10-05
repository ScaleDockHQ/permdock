import type { Principal } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  principal,
  relation,
  resource,
  role,
} from "permdock";
import { z } from "zod";

/**
 * CentraKit's shapes that differ from PermDock's defaults: `view` and
 * `archive` verbs, a platform and an organization resource that share the
 * segment `billing`, legacy `organization.*` and `system.*` keys, platform
 * support tiers as global custom roles, and expenses signed off by the
 * expense's manager, then the report's approver. A viewer reads only the
 * reports it approves, which splits `reports.view` into two grant keys.
 */
const Customer = z.object({ id: z.uuid(), organization_id: z.uuid() });
const Billing = z.object({ id: z.uuid(), organization_id: z.uuid() });
const PlatformBilling = z.object({ id: z.uuid() });
const Report = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  approver_id: z.uuid(),
});
const Expense = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  manager_id: z.uuid(),
  report_id: z.uuid(),
  amount: z.number(),
});

const organization = {
  organization: { field: "organization_id", memberOf: "organization" },
} as const;

export const permissions = definePermissions(
  {
    customers: resource(Customer, {
      id: "id",
      actions: {
        view: { title: "View customer" },
        update: {},
        archive: { title: "Archive customer", x: { undo: "30d" } },
      },
      relations: organization,
    }),
    billing: resource(Billing, {
      id: "id",
      actions: ["view"],
      relations: organization,
    }),
    platform: {
      billing: resource(PlatformBilling, {
        id: "id",
        name: "platform_billing",
        actions: ["view"],
      }),
    },
    reports: resource(Report, {
      id: "id",
      actions: ["view"],
      relations: { ...organization, approver: { field: "approver_id" } },
    }),
    expenses: resource(Expense, {
      id: "id",
      actions: ["view", "pay"],
      relations: { ...organization, manager: { field: "manager_id" } },
      links: { report: { field: "report_id", resource: "reports" } },
    }),
  },
  {
    renamed: {
      "organization.customers.view": "customers.view",
      "organization.customers.archive": "customers.archive",
      "system.billing.view": "platform.billing.view",
    },
  },
);

export const roles = defineRoles({
  admin: { on: "organization" },
  member: { on: "organization" },
  viewer: { on: "organization" },
  support: { assignable: true },
  "billing-ops": { assignable: true },
  "platform-admin": {},
});

export const managerThenApprover = {
  mode: "sequential",
  stages: [
    { by: relation(permissions.expenses, "manager") },
    {
      by: relation(permissions.reports, "approver", { through: ["report"] }),
    },
  ],
} as const;

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organization_id" } },
    subject: (user: Principal | null) => user,
    roles: [
      role(
        roles.admin,
        [
          allow([
            permissions.customers.view,
            permissions.customers.update,
            permissions.customers.archive,
            permissions.billing.view,
          ]),
        ],
        { on: "organization" },
      ),
      role(
        roles.member,
        [
          allow([
            permissions.customers.view,
            permissions.expenses.view,
            permissions.reports.view,
          ]),
          allow(permissions.expenses.pay, { approval: managerThenApprover }),
        ],
        { on: "organization" },
      ),
      role(
        roles.viewer,
        [
          allow(permissions.customers.view),
          allow(permissions.reports.view, {
            where: { approver_id: principal.id },
          }),
        ],
        { on: "organization" },
      ),
      role(roles.support, [allow(permissions.customers.view)]),
      role(roles["billing-ops"], [allow(permissions.platform.billing.view)]),
      role(roles["platform-admin"], [allow(permissions.customers.archive)]),
    ],
  },
);
