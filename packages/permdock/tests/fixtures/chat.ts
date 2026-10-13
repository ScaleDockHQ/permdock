import { z } from "zod";

import type { Principal } from "../../src/core/subject.ts";

import { allow } from "../../src/core/grant-builders.ts";
import { memoryMembershipSource } from "../../src/core/memory-sources.ts";
import { defineOperations } from "../../src/core/operations.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { memoryPrincipalSource } from "../../src/core/principal-source.ts";
import { role } from "../../src/core/role-builder.ts";

const Invoice = z.object({ id: z.string(), orgId: z.string() });

export const chatPermissions = definePermissions({
  invoice: resource(Invoice, {
    id: "id",
    actions: ["read", "pay"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const p = chatPermissions;

export const chatPolicy = definePolicy(p, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow(p.invoice.read)], { on: "tenant" }),
    role(
      "billing",
      [allow(p.invoice.read), allow(p.invoice.pay, { approval: {} })],
      { on: "tenant" },
    ),
  ],
  subject: (user: Principal | null) => user,
});

export const invoices: Readonly<
  Record<string, { readonly id: string; readonly orgId: string }>
> = {
  i1: { id: "i1", orgId: "o1" },
  i2: { id: "i2", orgId: "o2" },
};

export const chatOperations = defineOperations(p, {
  "invoice.show": {
    permission: p.invoice.read,
    data: (input: { readonly id: string }) => invoices[input.id] ?? null,
    meta: { risk: "low", effects: ["read"], title: "Show an invoice" },
  },
  "invoice.pay": {
    permission: p.invoice.pay,
    data: (input: { readonly id: string }) => invoices[input.id] ?? null,
    meta: { risk: "high", effects: ["spend"], title: "Pay an invoice" },
  },
});

export const chatPrincipals = memoryPrincipalSource({
  principals: [
    { id: "u_1", kind: "user", tenant: "o1" },
    { id: "u_2", kind: "user", tenant: "o1" },
    { id: "u_3", kind: "user", tenant: "o1" },
  ],
  identities: [
    {
      identity: {
        kind: "chat",
        provider: "slack",
        value: "U1",
        workspace: "T1",
      },
      principal: "u_1",
    },
    {
      identity: {
        kind: "chat",
        provider: "slack",
        value: "U2",
        workspace: "T1",
      },
      principal: "u_2",
    },
    {
      identity: {
        kind: "chat",
        provider: "slack",
        value: "U3",
        workspace: "T1",
      },
      principal: "u_3",
    },
  ],
});

export const chatMemberships = memoryMembershipSource({
  u_1: [{ scope: "tenant", id: "o1", roles: ["billing"] }],
  u_2: [{ scope: "tenant", id: "o1", roles: ["member"] }],
  u_3: [{ scope: "tenant", id: "o1", roles: ["billing"] }],
});

export const billing = { provider: "slack", userId: "U1", workspace: "T1" };
export const member = { provider: "slack", userId: "U2", workspace: "T1" };
export const approver = { provider: "slack", userId: "U3", workspace: "T1" };
export const stranger = { provider: "slack", userId: "U9", workspace: "T1" };
