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

export const WORKSPACE = "T0ACME";

export const policy = definePolicy(p, {
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

const users: readonly Principal[] = [
  { id: "u_billing", kind: "user", tenant: "acme" },
  { id: "u_finance", kind: "user", tenant: "acme" },
  { id: "u_member", kind: "user", tenant: "acme" },
];

/** Each user's Slack member id, linked once when they connect Slack in the app. */
export const slackIds: Readonly<Record<string, string>> = {
  u_billing: "U0BILLING",
  u_finance: "U0FINANCE",
  u_member: "U0MEMBER",
};

export const memberships = memoryMembershipSource({
  u_billing: [{ scope: "tenant", id: "acme", roles: ["billing"] }],
  u_finance: [{ scope: "tenant", id: "acme", roles: ["billing"] }],
  u_member: [{ scope: "tenant", id: "acme", roles: ["member"] }],
});

export const principals = memoryPrincipalSource({
  principals: users,
  identities: users.map((user) => ({
    identity: {
      kind: "chat",
      provider: "slack",
      value: slackIds[user.id] ?? "",
      workspace: WORKSPACE,
    },
    principal: user.id,
  })),
});
