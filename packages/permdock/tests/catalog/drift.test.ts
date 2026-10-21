import { describe, expect, it } from "vitest";

import type { ScanResult } from "../../src/cli/types.ts";
import type { PolicyDocument } from "../../src/index.ts";

import {
  catalogDrift,
  hostedGrantFindings,
  policyFromCatalog,
  pushedPolicy,
} from "../../src/catalog/index.ts";
import { buildCatalog } from "../../src/cli/catalog-doc.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  parseCatalogEventData,
  resource,
  role,
} from "../../src/index.ts";

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

function build(withVoid: boolean, roles: readonly string[]) {
  const tree = definePermissions({
    invoice: resource({ actions: withVoid ? ["read", "void"] : ["read"] }),
    ledger: resource({ actions: ["read"] }),
  });
  const policy = definePolicy(tree, {
    hostable: [tree.invoice],
    roles: roles.map((name) =>
      role(name, [allow(tree.invoice.read, { approval: "human" })]),
    ),
    subject: () => null,
  });
  const catalog = buildCatalog(tree, scan, "2026-10-01T00:00:00Z", policy);
  return { catalog, rebuilt: policyFromCatalog(catalog, pushedPolicy(policy)) };
}

const document: PolicyDocument = {
  v: 1,
  id: "pol_1",
  fingerprint: "doc-fp",
  catalog: "cat",
  issuedAt: "2026-10-01T00:00:00Z",
  grants: [
    {
      id: "g-void",
      permission: "invoice.void",
      effect: "allow",
      to: { kind: "role", role: "finance", scope: "global" },
    },
    {
      id: "g-read",
      permission: "invoice.read",
      effect: "allow",
      to: { kind: "role", role: "auditor", scope: "global" },
      approval: "human",
    },
    {
      id: "g-ledger",
      permission: "ledger.read",
      effect: "allow",
      to: { kind: "role", role: "finance", scope: "global" },
    },
    {
      id: "g-opaque",
      permission: "invoice.read",
      effect: "allow",
      to: { kind: "role", role: "finance", scope: "global" },
      approval: "human",
      where: { op: "opaque", sql: "true", fingerprint: "x" },
    },
    {
      id: "g-weak",
      permission: "invoice.read",
      effect: "allow",
      to: { kind: "role", role: "finance", scope: "global" },
    },
  ],
};

describe("hostedGrantFindings", () => {
  it("maps each drop reason the catalog caused onto a finding", () => {
    const { rebuilt } = build(false, ["finance"]);
    expect(hostedGrantFindings(rebuilt, document)).toEqual([
      {
        code: "permission-removed",
        permission: "invoice.void",
        grant: "g-void",
      },
      { code: "grantee-removed", permission: "invoice.read", grant: "g-read" },
      { code: "not-hostable", permission: "ledger.read", grant: "g-ledger" },
      {
        code: "approval-tightened",
        permission: "invoice.read",
        grant: "g-weak",
      },
    ]);
  });

  it("has nothing to report without a document", () => {
    const { rebuilt } = build(false, ["finance"]);
    expect(hostedGrantFindings(rebuilt, null)).toEqual([]);
  });
});

describe("catalogDrift", () => {
  it("returns drift event data that parses as CatalogEventData", () => {
    const before = build(true, ["finance", "auditor"]);
    const after = build(false, ["finance"]);
    const data = catalogDrift({
      previous: before.catalog,
      next: after.catalog,
      policy: after.rebuilt,
      document,
    });
    expect(data.kind).toBe("drift");
    expect(data.fingerprint).toBe(after.catalog.fingerprint);
    expect(data.previous).toBe(before.catalog.fingerprint);
    expect(data.findings?.map((finding) => finding.code)).toEqual([
      "permission-removed",
      "grantee-removed",
      "not-hostable",
      "approval-tightened",
    ]);
    expect(parseCatalogEventData(JSON.parse(JSON.stringify(data)))).toEqual(
      data,
    );
  });
});
