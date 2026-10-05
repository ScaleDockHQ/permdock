import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { ApprovalRequest } from "./types.ts";

import { findPermission } from "../core/permissions.ts";
import { requestApprovers } from "./relations.ts";

/**
 * The `holder(permission)` approvers of `request` that `approver` holds, for
 * `ApprovalVerdict.permissions`: each permission key the approver's own
 * instance grants without a row. `approver` must be an instance for the
 * approving principal in the request's tenant; for any other tenant, or an
 * anonymous instance, it holds nothing. A check that throws holds nothing.
 */
export function approverPermissions(
  request: ApprovalRequest,
  approver: PermDock,
): readonly string[] {
  const approvers = request.approvers;
  const principal = approver.subject.principal;
  const tenant = request.subject.principal?.tenant;
  if (
    approvers === undefined ||
    principal === null ||
    (tenant !== undefined && principal.tenant !== tenant)
  ) {
    return [];
  }
  const keys = new Set<string>();
  for (const item of requestApprovers(approvers)) {
    if (item.kind === "permission") {
      keys.add(item.permission);
    }
  }
  return [...keys].filter((key) => {
    const leaf = findPermission(approver.permissions, key);
    if (leaf === undefined) {
      return false;
    }
    try {
      // SAFETY: decide's instance and collection overloads share one implementation; a rowless check answers at tenant level.
      const decide = approver.decide as (
        permission: Permission,
        data?: unknown,
      ) => ReturnType<PermDock["decide"]>;
      return decide(leaf).outcome === "granted";
    } catch {
      return false;
    }
  });
}
