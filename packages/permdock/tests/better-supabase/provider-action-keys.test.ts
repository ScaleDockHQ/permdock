import { describe, expect, it } from "vitest";

import type { ScanResult } from "../../src/cli/types.ts";

import { authorizationProvider } from "../../src/better-supabase/index.ts";
import { policyFromCatalog, pushedPolicy } from "../../src/catalog/index.ts";
import { parseCatalog } from "../../src/catalog/parse.ts";
import { buildCatalog } from "../../src/cli/catalog-doc.ts";
import {
  definePermissions,
  definePolicy,
  listPermissions,
  resource,
} from "../../src/index.ts";
import { supabaseHookManifestFixture } from "../../src/testing/supabase-fixtures.ts";

const scan: ScanResult = {
  roots: [],
  definitionFiles: {},
  usages: {},
  unknown: [],
  dynamic: [],
  roleNames: [],
  planNames: [],
  allowKeys: [],
  snapshots: [],
  unparsed: [],
};

const tree = definePermissions({
  invoice: resource({
    actions: {
      recordPayment: {
        title: "Record payments",
        answers: ["blocks.invoices.recordPayment", "blocks.invoices.refund"],
      },
      read: {},
    },
  }),
  doc: resource({ collection: { read: { answers: ["buckets.docs.read"] } } }),
});

describe("meta.answers", () => {
  it("refuses an entry that names no better-supabase action", () => {
    expect(() =>
      definePermissions({
        invoice: resource({ actions: { pay: { answers: ["invoices.pay"] } } }),
      }),
    ).toThrow(/meta\.answers of action 'pay' has "invoices\.pay"/u);
    expect(() =>
      definePermissions({
        invoice: resource({
          // @ts-expect-error answers is a list
          actions: { pay: { answers: "blocks.invoices.pay" } },
        }),
      }),
    ).toThrow(/must be an array/u);
  });

  it("lifts answers out of meta into the catalog, and back into a policy", () => {
    const catalog = buildCatalog(tree, scan, "2026-11-24T00:00:00Z");
    const pay = catalog.permissions.find(
      (permission) => permission.key === "invoice.recordPayment",
    );
    expect(pay?.answers).toStrictEqual([
      "blocks.invoices.recordPayment",
      "blocks.invoices.refund",
    ]);
    expect(pay?.meta).toStrictEqual({ title: "Record payments" });
    expect(
      catalog.permissions.find(
        (permission) => permission.key === "invoice.read",
      ),
    ).not.toHaveProperty("answers");
    expect(() => parseCatalog(catalog)).not.toThrow();
    const policy = definePolicy(tree, { subject: () => null, roles: [] });
    const rebuilt = policyFromCatalog(
      JSON.parse(JSON.stringify(catalog)),
      JSON.parse(JSON.stringify(pushedPolicy(policy))),
      { subject: () => null },
    );
    expect(
      listPermissions(rebuilt.permissions)
        .flatMap((leaf) => leaf.meta.answers ?? [])
        .toSorted(),
    ).toStrictEqual([
      "blocks.invoices.recordPayment",
      "blocks.invoices.refund",
      "buckets.docs.read",
    ]);
  });
});

describe("authorizationProvider actionKeys", () => {
  it("emits actionKeys from the catalog's answers", () => {
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
      catalog: buildCatalog(tree, scan, "2026-11-24T00:00:00Z"),
    });
    expect(provider.actionKeys).toStrictEqual({
      blocks: {
        invoices: {
          recordPayment: "invoice.recordPayment",
          refund: "invoice.recordPayment",
        },
      },
      buckets: { docs: { read: "doc.read" } },
    });
    expect(provider.problems).toBeUndefined();
  });

  it("leaves out an action two permissions answer and says why", () => {
    const clash = definePermissions({
      invoice: resource({
        actions: {
          pay: { answers: ["blocks.invoices.recordPayment"] },
          void: { answers: ["blocks.invoices.recordPayment", "topics.a.b"] },
        },
      }),
    });
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
      catalog: buildCatalog(clash, scan, "2026-11-24T00:00:00Z"),
    });
    expect(provider.actionKeys).toStrictEqual({
      topics: { a: { b: "invoice.void" } },
    });
    expect(provider.problems).toStrictEqual([
      "blocks.invoices.recordPayment is answered by both invoice.pay and invoice.void; it is left out of actionKeys.",
    ]);
  });

  it("sets no actionKeys without answers", () => {
    const plain = definePermissions({
      invoice: resource({ actions: ["read"] }),
    });
    expect(
      authorizationProvider({
        manifest: supabaseHookManifestFixture,
        catalog: buildCatalog(plain, scan, "2026-11-24T00:00:00Z"),
      }),
    ).not.toHaveProperty("actionKeys");
  });
});
