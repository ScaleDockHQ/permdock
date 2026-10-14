import type { OperationRisk } from "../core/operation-risks.ts";
import type { CatalogFinding } from "../core/sink.ts";
import type { CatalogDocument } from "./types.ts";

import { OPERATION_RISKS } from "../core/operation-risks.ts";

function rank(risk: OperationRisk | undefined): number {
  return OPERATION_RISKS.indexOf(risk ?? "low");
}

function requiresApproval(
  catalog: CatalogDocument,
  permission: string,
): boolean {
  const found = catalog.permissions.find((entry) => entry.key === permission);
  return (found?.approvals?.length ?? 0) > 0;
}

/**
 * Operations, matched by name, whose `meta.risk` rose or whose permission
 * stopped requiring approval between two catalogs. A new or removed
 * operation is not a finding.
 */
export function operationFindings(
  previous: CatalogDocument,
  next: CatalogDocument,
): readonly CatalogFinding[] {
  const before = new Map(
    (previous.operations ?? []).map((operation) => [operation.name, operation]),
  );
  const findings: CatalogFinding[] = [];
  for (const operation of next.operations ?? []) {
    const old = before.get(operation.name);
    if (old === undefined) {
      continue;
    }
    if (rank(operation.meta.risk) > rank(old.meta.risk)) {
      findings.push({
        code: "operation-risk-raised",
        operation: operation.name,
        permission: operation.permission,
        previous: old.meta.risk ?? "low",
        risk: operation.meta.risk ?? "low",
      });
    }
    if (
      requiresApproval(previous, old.permission) &&
      !requiresApproval(next, operation.permission)
    ) {
      findings.push({
        code: "operation-approval-removed",
        operation: operation.name,
        permission: operation.permission,
      });
    }
  }
  return findings;
}
