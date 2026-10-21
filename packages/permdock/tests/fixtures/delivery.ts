import { z } from "zod";

import type { PermDock } from "../../src/core/permdock.ts";
import type { Policy } from "../../src/core/policy-types.ts";
import type { Principal } from "../../src/core/subject.ts";

import { allow } from "../../src/core/grant-builders.ts";
import { memoryMembershipSource } from "../../src/core/memory-sources.ts";
import { defineOperations } from "../../src/core/operations.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { memoryPrincipalSource } from "../../src/core/principal-source.ts";
import { role } from "../../src/core/role-builder.ts";

const Invoice = z.object({ id: z.string(), orgId: z.string() });

export const deliveryPermissions = definePermissions({
  invoice: resource(Invoice, {
    id: "id",
    actions: ["read", "pay"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const p = deliveryPermissions;

type DeliveryVocabulary =
  typeof deliveryPolicy extends Policy<never, Principal, infer V> ? V : never;

export const deliveryPolicy = definePolicy(p, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow(p.invoice.read)], { on: "tenant" }),
    role("billing", [allow([p.invoice.read, p.invoice.pay])], { on: "tenant" }),
    role("customer", [allow(p.invoice.read)], { on: p.invoice }),
  ],
  subject: (user: Principal | null) => user,
});

export const deliveryOperations = defineOperations(p, {
  "invoice.send": {
    permission: p.invoice.read,
    meta: { risk: "low", effects: ["send"], title: "Send an invoice" },
  },
});

export const invoice = { id: "i1", orgId: "o1" };

const principals: readonly Principal[] = [
  { id: "u_1", kind: "user", tenant: "o1" },
  { id: "u_2", kind: "user", tenant: "o1" },
  { id: "u_3", kind: "user", tenant: "o2" },
  { id: "u_4", kind: "user", tenant: "o1" },
  {
    id: "c_1",
    kind: "contact",
    memberships: [
      { on: { resource: "invoice", id: "i1" }, roles: ["customer"] },
    ],
  },
];

const deliveryMemberships = memoryMembershipSource({
  u_1: [{ scope: "tenant", id: "o1", roles: ["billing"] }],
  u_2: [{ scope: "tenant", id: "o1", roles: ["member"] }],
  u_3: [{ scope: "tenant", id: "o2", roles: ["member"] }],
  u_4: [],
  c_1: [{ on: { resource: "invoice", id: "i1" }, roles: ["customer"] }],
});

export const deliveryPrincipals = memoryPrincipalSource({
  principals,
  identities: [
    { identity: { kind: "email", value: "ann@acme.test" }, principal: "u_2" },
    {
      identity: { kind: "email", value: "otto@globex.test" },
      principal: "u_3",
    },
    {
      identity: { kind: "email", value: "cleo@client.test" },
      principal: "c_1",
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
  ],
});

/**
 * The sender: `u_1`, billing in `o1`, with the principal source `decideFor`
 * reads.
 */
export async function sender(
  id = "u_1",
): Promise<PermDock<DeliveryVocabulary>> {
  const principal = principals.find((entry) => entry.id === id);
  if (principal === undefined) {
    throw new Error(`no fixture principal ${id}`);
  }
  return getPermDockSync(deliveryPolicy, principal, {
    memberships: deliveryMemberships,
    principals: deliveryPrincipals,
  });
}
