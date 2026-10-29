import type {
  ApprovalPolicy,
  ApprovalPolicySource,
} from "../core/approval-policies.ts";
import type { SqlQuery } from "./sources.ts";

import { isRecord } from "../core/compact.ts";
import { quoteQualifiedTable } from "../core/sql.ts";

export type TableApprovalPolicySourceOptions = {
  readonly query: SqlQuery;
  /**
   * The schema holding `permdock_approval_policies_for`. Defaults to
   * `permdock`, where `rls.approvals.tenantPolicies` writes it.
   */
  readonly schema?: string;
  /**
   * The function to call, when `rls.approvals.tenantPolicies.function` renames
   * it. Defaults to `permdock_approval_policies_for`.
   */
  readonly function?: string;
};

function rowsOf(
  result: Awaited<ReturnType<SqlQuery>>,
): readonly Record<string, unknown>[] {
  // SAFETY: SqlQuery's only other variant has rows; Array.isArray does not narrow readonly arrays.
  return Array.isArray(result)
    ? result
    : (result as { readonly rows: readonly Record<string, unknown>[] }).rows;
}

/**
 * Approval policies from the table `rls.approvals.tenantPolicies` generates:
 * the subject's tenants' enabled rows and every platform floor. A row whose
 * body is not an object throws, and the evaluator checks every entry with
 * `validateApprovalPolicy`, so a bad row denies every call an allow would grant
 * until it is fixed.
 */
export function tableApprovalPolicySource(
  options: TableApprovalPolicySourceOptions,
): ApprovalPolicySource {
  const fn = quoteQualifiedTable(
    `${options.schema ?? "permdock"}.${options.function ?? "permdock_approval_policies_for"}`,
  );
  return {
    name: "table",
    async approvalPoliciesFor(query) {
      const rows = rowsOf(
        await options.query(`select p.body from ${fn}($1::text[]) p(body)`, [
          [...query.tenants],
        ]),
      );
      return rows.map((row) => {
        const body: unknown = row["body"];
        if (!isRecord(body)) {
          throw new TypeError(
            "PermDock: an approval_policies row has a body that is not an object",
          );
        }
        // SAFETY: the evaluator validates every entry with validateApprovalPolicy and fails closed.
        return body as ApprovalPolicy;
      });
    },
  };
}
