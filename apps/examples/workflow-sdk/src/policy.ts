import type { Automation, Principal, Subject } from "permdock";

import {
  allow,
  definePolicy,
  memoryAutomationSource,
  memoryPrincipalSource,
  role,
} from "permdock";

import { operations, permissions } from "./permissions.ts";

const p = permissions;

export const policy = definePolicy(p, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role(
      "billing",
      [allow(p.invoice.read), allow(p.invoice.send, { approval: {} })],
      { on: "tenant" },
    ),
    role("finance", [allow(p.invoice.read), allow(p.invoice.send)], {
      on: "tenant",
    }),
  ],
  subject: (subject: Subject) => subject.principal,
});

const users: readonly Principal[] = [
  {
    id: "u_billing",
    kind: "user",
    tenant: "acme",
    memberships: [{ scope: "tenant", id: "acme", roles: ["billing"] }],
  },
  {
    id: "u_finance",
    kind: "user",
    tenant: "acme",
    memberships: [{ scope: "tenant", id: "acme", roles: ["finance"] }],
  },
];

export const principals = memoryPrincipalSource({ principals: users });

/**
 * Published by `u_billing` through `permdock.decideAutomation`; every run acts
 * with their live rights.
 */
const sendOverdue: Automation = {
  v: 1,
  id: "send-overdue",
  version: 1,
  mode: "publisher",
  principal: "u_billing",
  publishedBy: "u_billing",
  publishedAt: "2026-10-14T09:00:00Z",
  tenant: "acme",
  operations: Object.keys(operations),
  permissions: Object.values(operations).map(
    (operation) => operation.permission.key,
  ),
};

export const automations = memoryAutomationSource([sendOverdue]);

export function subjectOf(id: string): Subject {
  const principal = users.find((user) => user.id === id);
  if (!principal) {
    throw new Error(`No user ${id}`);
  }
  return { principal, context: {} };
}
