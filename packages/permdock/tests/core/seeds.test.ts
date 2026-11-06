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

  it("rejects an unknown scope or permission and keeps a custom role's keys", () => {
    const other = definePermissions({ note: resource({ actions: ["read"] }) });
    expect(() =>
      defineSeeds(policy, {
        defaults: { roles: [{ key: "admin", scope: "nowhere", grants: [] }] },
      }),
    ).toThrow(/unknown scope 'nowhere'/u);
    expect(() =>
      defineSeeds(policy, {
        defaults: {
          roles: [{ key: "admin", scope: "tenant", grants: [other.note.read] }],
        },
      }),
    ).toThrow(/unknown permission 'note.read'/u);
    expect(() =>
      defineSeeds(policy, {
        fixtures: {
          customRoles: [
            { tenant: "t", key: "extra", grants: [other.note.read] },
          ],
        },
      }),
    ).toThrow(/custom role extra names unknown permission 'note.read'/u);
    const seeds = defineSeeds(policy, {
      defaults: { roles: [{ key: "admin", scope: "global", grants: [] }] },
      fixtures: {
        users: { ada: { id: "u1" } },
        customRoles: [
          { tenant: "t", key: "extra", grants: [permissions.doc.read] },
        ],
      },
    });
    expect(seeds.defaults.roles[0]?.scope).toBe("global");
    expect(seeds.fixtures.customRoles).toStrictEqual([
      { tenant: "t", key: "extra", grants: ["doc.read"] },
    ]);
    expect(seeds.fixtures.users["ada"]?.id).toBe("u1");
  });
});
