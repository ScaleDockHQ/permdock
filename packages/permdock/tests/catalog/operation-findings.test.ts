import { describe, expect, it } from "vitest";

import type {
  CatalogDocument,
  CatalogOperation,
  CatalogPermission,
} from "../../src/catalog/index.ts";

import { operationFindings } from "../../src/catalog/index.ts";

function permission(
  key: string,
  approvals?: CatalogPermission["approvals"],
): CatalogPermission {
  return {
    key,
    scope: key.replace(".", ":"),
    resource: key.split(".")[0] ?? key,
    action: key.split(".")[1] ?? key,
    arity: "instance",
    meta: {},
    usages: [],
    rowConditions: false,
    ...(approvals === undefined ? {} : { approvals }),
  };
}

function operation(
  name: string,
  key: string,
  risk?: CatalogOperation["meta"]["risk"],
): CatalogOperation {
  return { name, permission: key, meta: risk === undefined ? {} : { risk } };
}

function catalog(
  operations: readonly CatalogOperation[] | undefined,
  permissions: readonly CatalogPermission[] = [permission("invoice.refund")],
): CatalogDocument {
  return {
    $schema: "https://permdock.com/schemas/catalog-v1.json",
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: "test",
    resources: {},
    permissions,
    roles: [],
    grants: [],
    ...(operations === undefined ? {} : { operations }),
  };
}

describe("operationFindings", () => {
  it("reports a raised risk with the previous and new level", () => {
    const findings = operationFindings(
      catalog([operation("refundInvoice", "invoice.refund", "medium")]),
      catalog([operation("refundInvoice", "invoice.refund", "critical")]),
    );
    expect(findings).toStrictEqual([
      {
        code: "operation-risk-raised",
        operation: "refundInvoice",
        permission: "invoice.refund",
        previous: "medium",
        risk: "critical",
      },
    ]);
  });

  it("treats an unset risk as low", () => {
    const findings = operationFindings(
      catalog([operation("refundInvoice", "invoice.refund")]),
      catalog([operation("refundInvoice", "invoice.refund", "high")]),
    );
    expect(findings).toStrictEqual([
      expect.objectContaining({ previous: "low", risk: "high" }),
    ]);
  });

  it("ignores a lowered or unchanged risk, a new operation and a removed one", () => {
    const findings = operationFindings(
      catalog([
        operation("refundInvoice", "invoice.refund", "high"),
        operation("voidInvoice", "invoice.refund", "low"),
        operation("gone", "invoice.refund", "low"),
      ]),
      catalog([
        operation("refundInvoice", "invoice.refund", "medium"),
        operation("voidInvoice", "invoice.refund", "low"),
        operation("added", "invoice.refund", "critical"),
      ]),
    );
    expect(findings).toStrictEqual([]);
  });

  it("reports an operation whose permission no longer requires approval", () => {
    const findings = operationFindings(
      catalog(
        [operation("refundInvoice", "invoice.refund", "high")],
        [permission("invoice.refund", ["human"])],
      ),
      catalog(
        [operation("refundInvoice", "invoice.refund", "high")],
        [permission("invoice.refund")],
      ),
    );
    expect(findings).toStrictEqual([
      {
        code: "operation-approval-removed",
        operation: "refundInvoice",
        permission: "invoice.refund",
      },
    ]);
  });

  it("reports an operation moved onto a permission that needs no approval", () => {
    const findings = operationFindings(
      catalog(
        [operation("refundInvoice", "invoice.refund")],
        [permission("invoice.refund", ["human"]), permission("invoice.read")],
      ),
      catalog(
        [operation("refundInvoice", "invoice.read")],
        [permission("invoice.refund", ["human"]), permission("invoice.read")],
      ),
    );
    expect(findings).toStrictEqual([
      {
        code: "operation-approval-removed",
        operation: "refundInvoice",
        permission: "invoice.read",
      },
    ]);
  });

  it("returns nothing for catalogs without operations", () => {
    expect(
      operationFindings(catalog(undefined), catalog(undefined)),
    ).toStrictEqual([]);
  });
});
