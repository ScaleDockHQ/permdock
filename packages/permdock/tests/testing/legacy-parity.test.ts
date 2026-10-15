import { describe } from "vitest";

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { testLegacyParity } from "../../src/testing/index.ts";

const permissions = definePermissions({
  invoice: resource({ actions: ["read", "pay"] }),
});
const policy = definePolicy(permissions, {
  roles: [
    role("admin", [
      allow(permissions.invoice.read),
      allow(permissions.invoice.pay),
    ]),
    role("member", [allow(permissions.invoice.read)]),
  ],
  subject: (user: { readonly id: string; readonly role: string } | null) =>
    user === null ? null : { id: user.id, roles: [user.role] },
});

// The application's check before PermDock: a role string compared inline.
function legacyCheck(input: {
  readonly permission: { readonly key: string };
  readonly subject: {
    readonly principal: { readonly roles?: readonly string[] } | null;
  };
}): boolean {
  const roles = input.subject.principal?.roles ?? [];
  return input.permission.key === "invoice.read" || roles.includes("admin");
}

describe("testLegacyParity", () => {
  testLegacyParity(policy, legacyCheck, [
    {
      name: "a member reads an invoice",
      user: { id: "u1", role: "member" },
      permission: permissions.invoice.read,
      row: { id: "i1" },
    },
    {
      name: "a member cannot pay",
      user: { id: "u1", role: "member" },
      permission: permissions.invoice.pay,
      row: { id: "i1" },
    },
    {
      name: "a guest the legacy check let read is now denied",
      user: { id: "u2", role: "guest" },
      permission: permissions.invoice.read,
      row: { id: "i1" },
      expect: false,
    },
  ]);
});
