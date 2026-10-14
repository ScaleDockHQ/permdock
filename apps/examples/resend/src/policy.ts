import type { Principal } from "permdock";

import {
  allow,
  definePolicy,
  memoryMembershipSource,
  memoryPrincipalSource,
  role,
} from "permdock";

import { permissions } from "./permissions.ts";

const p = permissions;

export const policy = definePolicy(p, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow(p.invoice.read)], { on: "tenant" }),
    role(
      "billing",
      [allow(p.invoice.read), allow(p.invoice.pay, { approval: {} })],
      { on: "tenant" },
    ),
    role("customer", [allow(p.invoice.read)], { on: p.invoice }),
  ],
  subject: (user: Principal | null) => user,
});

const users: readonly Principal[] = [
  { id: "u_billing", kind: "user", tenant: "acme" },
  { id: "u_finance", kind: "user", tenant: "acme" },
  { id: "u_member", kind: "user", tenant: "acme" },
  { id: "c_client", kind: "contact" },
];

export const emails: Readonly<Record<string, string>> = {
  u_billing: "bea@acme.test",
  u_finance: "fin@acme.test",
  u_member: "mo@acme.test",
  c_client: "cleo@client.test",
};

export const memberships = memoryMembershipSource({
  u_billing: [{ scope: "tenant", id: "acme", roles: ["billing"] }],
  u_finance: [{ scope: "tenant", id: "acme", roles: ["billing"] }],
  u_member: [{ scope: "tenant", id: "acme", roles: ["member"] }],
  c_client: [
    { on: { resource: "invoice", id: "inv_42" }, roles: ["customer"] },
  ],
});

export const principals = memoryPrincipalSource({
  principals: users,
  identities: users.map((user) => ({
    identity: { kind: "email", value: emails[user.id] ?? "" },
    principal: user.id,
  })),
});

export function userById(id: string): Principal {
  const user = users.find((entry) => entry.id === id);
  if (user) {
    return user;
  }
  throw new Error(`No user ${id}`);
}
