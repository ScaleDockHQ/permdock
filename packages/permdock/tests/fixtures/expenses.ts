import { relation } from "../../src/core/grantee.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { memoryRelations } from "../../src/core/relations.ts";

export const permissions = definePermissions({
  report: resource({
    actions: ["read"],
    relations: { approver: { field: "approverId" } },
  }),
  expense: resource({
    actions: ["read", "pay"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      manager: { field: "managerId" },
    },
    links: { report: { field: "reportId", resource: "report" } },
  }),
});

const managerThenApprover = {
  mode: "sequential",
  stages: [
    { by: relation(permissions.expense, "manager") },
    {
      by: relation(permissions.report, "approver", { through: ["report"] }),
    },
  ],
} as const;

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role(
      "member",
      [
        allow(permissions.expense.read),
        allow(permissions.expense.pay, { approval: managerThenApprover }),
      ],
      { on: "tenant" },
    ),
  ],
  subject: (user: { readonly id: string } | null) =>
    user === null
      ? null
      : {
          id: user.id,
          tenant: "o1",
          memberships: [{ scope: "tenant", id: "o1", roles: ["member"] }],
        },
});

export const rows = {
  expense: [
    {
      id: "e1",
      orgId: "o1",
      managerId: "mia",
      reportId: "r1",
      amount: 5000,
    },
    { id: "e2", orgId: "o1", managerId: "mia", reportId: "r1", amount: 10 },
  ],
  report: [{ id: "r1", approverId: "rob" }],
};

export const relations = memoryRelations(permissions, { rows });
