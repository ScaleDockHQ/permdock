import { describe, expect, it } from "vitest";

import {
  allow,
  definePermissions,
  definePolicy,
  defineSeeds,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  doc: resource({
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
  roles: [role("admin", [allow(permissions.doc.read)], { on: "tenant" })],
});

describe(defineSeeds, () => {
  it("freezes permission keys from references", () => {
    const seeds = defineSeeds(policy, {
      defaults: {
        roles: [
          {
            key: "admin",
            scope: "tenant",
            system: true,
            grants: [permissions.doc.read],
          },
        ],
      },
    });
    expect(seeds.defaults.roles[0]?.grants).toStrictEqual(["doc.read"]);
    expect(Object.isFrozen(seeds)).toBe(true);
  });

  it("rejects an unknown role", () => {
    expect(() =>
      defineSeeds(policy, {
        defaults: {
          roles: [{ key: "billing_admin", scope: "tenant", grants: [] }],
        },
      }),
    ).toThrow(/unknown role 'billing_admin'/u);
  });
});
