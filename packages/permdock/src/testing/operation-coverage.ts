import { expect, it } from "vitest";

import type { OperationCoverageOptions } from "../openapi/coverage.ts";
import type { OperationPermissions } from "../openapi/operations.ts";

import { operationCoverage } from "../openapi/coverage.ts";

/**
 * Two tests over the declared operations and an OpenAPI document: every
 * operation under `tenantPaths` has an entry, and every entry matches an
 * operation. An undeclared tenant operation is denied by a gate, so this
 * catches a route added without a permission before it ships.
 */
export function testOperationCoverage(
  operations: OperationPermissions,
  document: unknown,
  options: OperationCoverageOptions,
): void {
  const coverage = operationCoverage(operations, document, options);

  it("declares every tenant-path operation of the document", () => {
    expect(coverage.undeclared).toStrictEqual([]);
  });

  it("declares no operation the document lacks", () => {
    expect(coverage.stale).toStrictEqual([]);
  });
}
