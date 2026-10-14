import type { PermDock } from "../../src/core/permdock.ts";
import type { Principal, Subject } from "../../src/core/subject.ts";

import { allow } from "../../src/core/grant-builders.ts";
import { actor } from "../../src/core/grantee.ts";
import { defineOperations } from "../../src/core/operations.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";

const org = { organization: { field: "orgId", memberOf: "organization" } };

export const permissions = definePermissions({
  invoice: resource({
    actions: ["read", "send", "delete"],
    relations: org,
  }),
  report: resource({ actions: ["run"], relations: org }),
});

export const operations = defineOperations(permissions, {
  read_invoice: {
    permission: permissions.invoice.read,
    meta: { risk: "low", effects: ["read"] },
  },
  send_invoice: {
    permission: permissions.invoice.send,
    meta: { risk: "medium", effects: ["send", "external"] },
  },
  delete_invoice: {
    permission: permissions.invoice.delete,
    meta: { risk: "high", effects: ["delete"] },
  },
});

const roles = [
  role(
    "owner",
    [
      allow(permissions.invoice.read),
      allow(permissions.invoice.send),
      allow(permissions.invoice.delete),
      allow(permissions.report.run),
    ],
    { on: "organization", assignable: true, meta: { manageRoles: true } },
  ),
  role(
    "billing",
    [
      allow(permissions.invoice.read),
      allow(permissions.invoice.send),
      allow(permissions.report.run),
    ],
    { on: "organization", assignable: true },
  ),
  role("reader", [allow(permissions.invoice.read)], {
    on: "organization",
    assignable: true,
  }),
];

export const policy = definePolicy(
  { permissions },
  {
    subject: (user: Subject) => user.principal,
    scopes: { organization: { key: "orgId" } },
    roles,
  },
);

/** The same roles, with every automation capped at reading invoices. */
export const cappedPolicy = definePolicy(
  { permissions },
  {
    subject: (user: Subject) => user.principal,
    scopes: { organization: { key: "orgId" } },
    roles,
    delegations: [
      {
        from: "billing",
        to: actor("automation"),
        permissions: [permissions.invoice.read],
      },
      {
        from: "owner",
        to: actor("automation"),
        permissions: [permissions.invoice.read],
      },
    ],
  },
);

export function person(
  id: string,
  roleNames: readonly string[],
  tenant = "o_1",
): Principal {
  return {
    id,
    kind: "user",
    tenant,
    memberships: roleNames.length === 0 ? [] : [{ tenant, roles: roleNames }],
  };
}

export function userSubject(
  id: string,
  roleNames: readonly string[],
  extra: Partial<Subject> = {},
): Subject {
  return { principal: person(id, roleNames), context: {}, ...extra };
}

export function permdockFor(subject: Subject, using = policy): PermDock {
  const instance = createPermDock(using, subject);
  if (instance instanceof Promise) {
    throw new TypeError("expected a synchronous instance");
  }
  return instance;
}

export const invoice = { id: "inv_1", orgId: "o_1" };
