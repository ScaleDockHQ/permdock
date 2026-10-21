import type {
  ApprovalDelegation,
  ApprovalDelegationSource,
} from "../approvals/types.ts";
import type { SqlQuery } from "./sources.ts";

import { quoteQualifiedTable } from "../core/sql.ts";
import { isoAt } from "../core/time.ts";

export type TableApprovalDelegationSourceOptions = {
  readonly query: SqlQuery;
  /**
   * Defaults to `permdock.approval_delegations`, the table
   * `rls.approvals.delegations` generates.
   */
  readonly table?: string;
};

function rowsOf(
  result: Awaited<ReturnType<SqlQuery>>,
): readonly Record<string, unknown>[] {
  // SAFETY: SqlQuery's only other variant has rows; Array.isArray does not narrow readonly arrays.
  return Array.isArray(result)
    ? result
    : (result as { readonly rows: readonly Record<string, unknown>[] }).rows;
}

function instant(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : isoAt(ms);
}

function list(value: unknown): readonly string[] | undefined | false {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return false;
    }
    items.push(item);
  }
  return items;
}

function delegationOf(
  row: Record<string, unknown>,
): ApprovalDelegation | undefined {
  const { id, delegator, delegate, tenant } = row;
  const from = instant(row["from"]);
  const until = instant(row["until"]);
  const permissions = list(row["permissions"]);
  const resources = list(row["resources"]);
  if (
    typeof id !== "string" ||
    typeof delegator !== "string" ||
    typeof delegate !== "string" ||
    (tenant !== null && typeof tenant !== "string") ||
    from === undefined ||
    until === undefined ||
    permissions === false ||
    resources === false
  ) {
    return undefined;
  }
  return {
    id,
    delegator,
    delegate,
    ...(typeof tenant === "string" ? { tenant } : {}),
    ...(permissions === undefined ? {} : { permissions }),
    ...(resources === undefined ? {} : { resources }),
    from,
    until,
  };
}

/**
 * Approval delegations (out-of-office covers) from the table
 * `rls.approvals.delegations` generates, so `approvalsHandler` and
 * `permdock_is_approver` read the same rows. A cover without a tenant applies
 * everywhere; a malformed row is skipped.
 */
export function tableApprovalDelegationSource(
  options: TableApprovalDelegationSourceOptions,
): ApprovalDelegationSource {
  const table = quoteQualifiedTable(
    options.table ?? "permdock.approval_delegations",
  );
  return {
    name: "table",
    async delegationsFor(query) {
      const values: unknown[] = [query.delegate, query.at];
      let tenant = "d.tenant is null";
      if (query.tenant !== undefined) {
        values.push(query.tenant);
        tenant = "(d.tenant is null or d.tenant = $3)";
      }
      const rows = rowsOf(
        await options.query(
          `select d.id::text as id, d.delegator::text as delegator, d.delegate::text as delegate, d.tenant::text as tenant, d.permissions, d.resources, d."from", d."until" from ${table} d where d.delegate::text = $1 and d."from" <= $2::timestamptz and $2::timestamptz < d."until" and ${tenant} order by d.id`,
          values,
        ),
      );
      return rows.flatMap((row) => {
        const entry = delegationOf(row);
        return entry === undefined ? [] : [entry];
      });
    },
  };
}
