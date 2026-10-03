import { describe } from "vitest";

import {
  allow,
  definePermissions,
  definePolicy,
  memoryRoleSource,
  resource,
  role,
} from "../../src/index.ts";
import { testClientParity } from "../../src/testing/client-parity.ts";
import {
  saasCustomRoles,
  saasPolicy,
  saasScenarios,
  saasUser,
} from "../../src/testing/saas/index.ts";

describe("testClientParity over the saas scenarios", () => {
  testClientParity(
    saasPolicy,
    saasScenarios.map((scenario) => ({
      name: scenario.name,
      user: saasUser(scenario),
      tenant: scenario.tenant,
      permission: scenario.permission,
      row: scenario.row,
      stricter:
        scenario.client === false || scenario.clientOutcome !== undefined,
    })),
    { customRoles: memoryRoleSource(saasCustomRoles) },
  );
});

const permissions = definePermissions({
  doc: resource({ id: "id", actions: ["read", "update"] }),
});

describe("testClientParity without a tenant or custom roles", () => {
  testClientParity(
    definePolicy(permissions, {
      roles: [role("viewer", [allow(permissions.doc.read)])],
      subject: (user: { readonly id: string }) => ({
        id: user.id,
        roles: ["viewer"],
      }),
    }),
    [
      {
        name: "viewer reads",
        user: { id: "u1" },
        permission: permissions.doc.read,
        row: { id: "d1" },
      },
      {
        name: "viewer cannot update",
        user: { id: "u1" },
        permission: permissions.doc.update,
        row: { id: "d1" },
      },
    ],
  );
});
