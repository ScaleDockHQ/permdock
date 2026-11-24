import { describe, expect, it } from "vitest";

import { authorizationProvider } from "../../src/better-supabase/index.ts";
import { supabaseHookManifestFixture } from "../../src/testing/supabase-fixtures.ts";

const catalog = (approvals: readonly unknown[]) => ({
  $schema: "https://permdock.com/schemas/catalog-v2.json",
  version: 2,
  generatedAt: "2026-01-01T00:00:00Z",
  generator: "test",
  resources: {},
  permissions: [
    {
      key: "invoice.pay",
      scope: "invoice:pay",
      resource: "invoice",
      action: "pay",
      arity: "instance",
      meta: {},
      usages: [],
      rowConditions: false,
      ...(approvals.length === 0 ? {} : { approvals }),
    },
  ],
});

const providerFor = (approvals: readonly unknown[]) =>
  authorizationProvider({
    manifest: supabaseHookManifestFixture,
    catalog: catalog(approvals),
  });

describe("operations approval floors", () => {
  it("maps a single by to one step under <resource>:<action>", () => {
    const provider = providerFor([
      { by: { kind: "permission", permission: "invoice.approve" } },
    ]);
    expect(provider.operations).toStrictEqual({
      "invoice:pay": {
        permission: "invoice.pay",
        approval: {
          steps: [
            { approvers: { permission: "invoice.approve" }, required: 1 },
          ],
        },
      },
    });
  });

  it("maps sequential stages, quorum and any-of approvers", () => {
    const provider = providerFor([
      {
        combine: "sequential",
        stages: [
          {
            by: {
              kind: "any-of",
              of: [
                { kind: "role", role: "admin", scope: "tenant" },
                { kind: "user", id: "u_1" },
                { kind: "user", id: "u_2" },
              ],
            },
            quorum: 2,
          },
          { by: { kind: "manager" } },
        ],
        ttl: 3600,
      },
    ]);
    expect(provider.operations?.["invoice:pay"]?.approval).toStrictEqual({
      steps: [
        { approvers: { role: "admin", users: ["u_1", "u_2"] }, required: 2 },
        { approvers: { manager: true }, required: 1 },
      ],
      mode: "sequential",
    });
  });

  it("leaves out an approval the block cannot express, with a problem", () => {
    for (const by of [
      [
        { kind: "role", role: "admin", scope: "tenant" },
        { kind: "user", id: "u_1" },
      ],
      { kind: "role", role: "admin", scope: "global" },
      { kind: "relation", relation: "owner" },
      { kind: "manager", levels: 2 },
    ]) {
      const provider = providerFor([{ by }]);
      expect(provider).not.toHaveProperty("operations");
      expect(provider.problems).toContainEqual(
        "operations: invoice.pay requires an approval whose approvers the approvals block cannot express, so invoice:pay has no approval floor.",
      );
    }
  });

  it("sets no floor for human approval, and names several approvals", () => {
    expect(providerFor(["human"])).not.toHaveProperty("operations");
    expect(providerFor(["human"]).problems ?? []).toStrictEqual(
      expect.not.arrayContaining([expect.stringContaining("operations:")]),
    );
    const several = providerFor(["human", { by: { kind: "user", id: "u_1" } }]);
    expect(several).not.toHaveProperty("operations");
    expect(several.problems).toContainEqual(
      "operations: invoice.pay requires several different approvals, so invoice:pay has no approval floor.",
    );
  });
});
