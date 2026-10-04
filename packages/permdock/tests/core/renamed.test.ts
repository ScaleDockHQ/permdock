import { describe, expect, it } from "vitest";

import type { ScanResult } from "../../src/cli/types.ts";

import { buildCatalog } from "../../src/cli/catalog-doc.ts";
import { diffCatalogs } from "../../src/cli/diff.ts";
import {
  customRoleClaim,
  resolveCustomRole,
  validateCustomRole,
} from "../../src/core/custom-roles.ts";
import { coveredByDelegation } from "../../src/core/delegation.ts";
import {
  definePermissions,
  findPermission,
  formerKeys,
  mergePermissions,
  resource,
} from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";

const shape = {
  customer: resource({
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
};

const before = definePermissions({
  customer: resource({
    id: "id",
    actions: ["view", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const permissions = definePermissions(shape, {
  renamed: {
    "customer.view": "customer.read",
    "organization.customers.view": "customer.read",
  },
});

const roles = defineRoles({ admin: { on: "tenant" } });

const options = {
  scopes: { tenant: { key: "orgId" } },
  subject: (user: { readonly id: string } | null) =>
    user === null ? null : { id: user.id },
} as const;

const policyBefore = definePolicy(
  { permissions: before, roles },
  {
    ...options,
    roles: [
      role(roles.admin, [
        allow(before.customer.view),
        allow(before.customer.update),
      ]),
    ],
  },
);

const policy = definePolicy(
  { permissions, roles },
  {
    ...options,
    roles: [
      role(roles.admin, [
        allow(permissions.customer.read),
        allow(permissions.customer.update),
      ]),
    ],
  },
);

const EMPTY_SCAN: ScanResult = {
  roots: [],
  definitionFiles: {},
  usages: {},
  unknown: [],
  dynamic: [],
  roleNames: [],
  planNames: [],
  allowKeys: [],
  snapshots: [],
};

describe("definePermissions renamed", () => {
  it("keeps leaves plain and records former keys out of band", () => {
    const leaf = permissions.customer.read;
    expect(JSON.parse(JSON.stringify(leaf))).toEqual({
      key: "customer.read",
      resource: "customer",
      action: "read",
      scope: "customer:read",
      meta: {},
    });
    expect(formerKeys(leaf)).toEqual([
      "customer.view",
      "organization.customers.view",
    ]);
    expect(formerKeys(permissions.customer.update)).toEqual([]);
    expect(formerKeys(JSON.parse(JSON.stringify(leaf)))).toEqual([]);
  });

  it("resolves a former key or scope to the current leaf", () => {
    expect(findPermission(permissions, "customer.view")).toBe(
      permissions.customer.read,
    );
    expect(findPermission(permissions, "customer:view")).toBe(
      permissions.customer.read,
    );
    expect(findPermission(permissions, "organization:customers:view")).toBe(
      permissions.customer.read,
    );
    expect(findPermission(permissions, "customer.delete")).toBeUndefined();
  });

  it("rejects a target that is not a key, a former key still in use and bad input", () => {
    expect(() =>
      definePermissions(shape, {
        renamed: { "customer.view": "customer.list" },
      }),
    ).toThrow("renamed target 'customer.list' is not a permission key");
    expect(() =>
      definePermissions(shape, {
        renamed: { "customer.update": "customer.read" },
      }),
    ).toThrow("renamed key 'customer.update' is still a permission key");
    expect(() =>
      definePermissions(shape, { renamed: { "a b": "customer.read" } }),
    ).toThrow("renamed key 'a b' is not a valid key");
    expect(() =>
      definePermissions(shape, {
        renamed: { "__proto__.x": "customer.read" },
      }),
    ).toThrow("is not a valid key");
    expect(() =>
      definePermissions(shape, {
        // SAFETY: deliberately wrong input to check the runtime guard.
        renamed: { "customer.view": 1 } as unknown as Record<string, string>,
      }),
    ).toThrow("must map to a current key");
  });

  it("rejects merged trees that claim the same former key", () => {
    const other = definePermissions(
      { invoice: resource({ actions: ["read"] }) },
      { renamed: { "customer.view": "invoice.read" } },
    );
    expect(() => mergePermissions(permissions, other)).toThrow(
      "renamed key 'customer.view' maps to both",
    );
    const current = definePermissions({
      legacy: resource({ name: "customer_legacy", actions: ["view"] }),
    });
    const clash = definePermissions(
      { invoice: resource({ actions: ["read"] }) },
      { renamed: { "legacy.view": "invoice.read" } },
    );
    expect(() => mergePermissions(current, clash)).toThrow(
      "renamed key 'legacy.view' is still a permission key",
    );
  });
});

describe("renamed keys in stored data", () => {
  const stored = {
    tenant: "acme",
    name: "support",
    grants: [
      { permission: "customer.view" },
      { permission: "customer.update" },
    ],
  };

  it("resolves a custom role stored under a former key and reports the rewrite", () => {
    expect(validateCustomRole(policy, stored)).toEqual({
      ok: true,
      permissions: ["customer.read", "customer.update"],
      dropped: [],
      renamed: [{ from: "customer.view", to: "customer.read" }],
    });
    expect(
      resolveCustomRole(policy, {
        ...stored,
        grants: [{ permission: "customer:view" }],
      }).dropped,
    ).toEqual([{ permission: "customer:view", reason: "unknown-permission" }]);
  });

  it("writes current keys into the claim when given the policy", () => {
    expect(customRoleClaim([stored])).toEqual({
      support: ["customer.view", "customer.update"],
    });
    expect(customRoleClaim([stored], policy)).toEqual({
      support: ["customer.read", "customer.update"],
    });
  });

  it("accepts an OAuth scope or GNAP access string issued before the rename", () => {
    const leaf = permissions.customer.read;
    expect(coveredByDelegation(leaf, { scopes: ["customer:view"] })).toBe(
      undefined,
    );
    expect(coveredByDelegation(leaf, { access: ["customer:view"] })).toBe(
      undefined,
    );
    expect(
      coveredByDelegation(permissions.customer.update, {
        scopes: ["customer:view"],
      }),
    ).toBe("not-delegated");
  });
});

describe("catalog and diff", () => {
  const at = "2026-10-03T00:00:00.000Z";
  const catalogA = buildCatalog(before, EMPTY_SCAN, at, policyBefore);
  const catalogB = buildCatalog(permissions, EMPTY_SCAN, at, policy);

  it("lists former keys on the catalog entry", () => {
    const entry = catalogB.permissions.find(
      (item) => item.key === "customer.read",
    );
    expect(entry?.renamedFrom).toEqual([
      "customer.view",
      "organization.customers.view",
    ]);
    expect(
      catalogB.permissions.find((item) => item.key === "customer.update")
        ?.renamedFrom,
    ).toBeUndefined();
  });

  it("reports a rename as non-breaking and keeps grants matched", () => {
    const result = diffCatalogs(
      { source: "a", catalog: catalogA, policy: undefined },
      { source: "b", catalog: catalogB, policy: undefined },
    );
    expect(result.permissions).toEqual({
      added: ["customer.read"],
      removed: [],
      renamed: [{ from: "customer.view", to: "customer.read" }],
    });
    expect(result.grants?.removed).toEqual([]);
    expect(result.breaking).toEqual([]);
  });

  it("reports dropping an alias as breaking", () => {
    const dropped = buildCatalog(
      definePermissions(shape),
      EMPTY_SCAN,
      at,
      undefined,
    );
    const result = diffCatalogs(
      { source: "b", catalog: catalogB, policy: undefined },
      { source: "c", catalog: dropped, policy: undefined },
    );
    expect(
      result.breaking
        .filter((change) => change.kind === "alias-removed")
        .map((change) => change.detail.split(" ")[0]),
    ).toEqual(["customer.view", "organization.customers.view"]);
  });
});
