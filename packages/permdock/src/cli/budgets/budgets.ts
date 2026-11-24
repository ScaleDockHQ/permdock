import type { Policy } from "../../index.ts";
import type { PermDockConfig } from "../types.ts";

import { scopeList } from "../../core/scopes.ts";
import { supabaseMembershipsBudget } from "../../supabase/budget.ts";
import { claimsSize } from "../claims-size.ts";
import { mostPrivilegedRole, snapshotSize } from "../snapshot-size.ts";
import { bundleSize } from "./bundle-size.ts";

/**
 * Memberships of the probe subject when `budgets.snapshot.memberships` is
 * unset.
 */
const PROBE_MEMBERSHIPS = 3;

type BudgetName = "bundle" | "snapshot" | "claims";

type BudgetBreach = {
  readonly budget: BudgetName;
  readonly bytes: number;
  /** Gzip bytes; null for the claim, which a token carries uncompressed. */
  readonly gzip: number | null;
  readonly limit: number;
  readonly largest: string;
};

/**
 * The snapshot options the project's own pages use: `omitStatic` when the
 * `bundle` kind is generated, since a snapshot written against the bundle
 * leaves the declared roles' grants out.
 */
export function snapshotProbeOptions(config: PermDockConfig): {
  readonly omitStatic: boolean;
} {
  return { omitStatic: config.gen?.kinds?.includes("bundle") === true };
}

export function breachText(breach: BudgetBreach): string {
  const gzip = breach.gzip === null ? "" : ` (${String(breach.gzip)} gzip)`;
  return `budgets.${breach.budget}: ${String(breach.bytes)} bytes${gzip}, over the ${String(breach.limit)} byte budget; the largest part is ${breach.largest}`;
}

/** Every budget in `config.budgets` the policy is over, in config order. */
export function budgetBreaches(
  policy: Policy,
  config: PermDockConfig,
): readonly BudgetBreach[] {
  const budgets = config.budgets;
  if (budgets === undefined) {
    return [];
  }
  const breaches: BudgetBreach[] = [];
  if (budgets.bundle !== undefined) {
    const report = bundleSize(policy);
    if (report.total.bytes > budgets.bundle) {
      breaches.push({
        budget: "bundle",
        bytes: report.total.bytes,
        gzip: report.total.gzip,
        limit: budgets.bundle,
        largest: report.largest,
      });
    }
  }
  const memberships = budgets.snapshot?.memberships ?? PROBE_MEMBERSHIPS;
  const role = mostPrivilegedRole(policy);
  if (budgets.snapshot !== undefined && role !== undefined) {
    const report = snapshotSize({
      policy,
      role,
      tenants: memberships,
      omitAssignable: false,
      ...snapshotProbeOptions(config),
    });
    if (
      typeof report !== "string" &&
      report.total.bytes > budgets.snapshot.bytes
    ) {
      breaches.push({
        budget: "snapshot",
        bytes: report.total.bytes,
        gzip: report.total.gzip,
        limit: budgets.snapshot.bytes,
        largest: report.largest,
      });
    }
  }
  const root = scopeList(policy.scopes)[0]?.name;
  if (budgets.claims !== undefined && root !== undefined) {
    const report = claimsSize({
      memberships,
      roles: 1,
      scope: root,
      budget: supabaseMembershipsBudget,
    });
    if (report.claimBytes > budgets.claims) {
      breaches.push({
        budget: "claims",
        bytes: report.claimBytes,
        gzip: null,
        limit: budgets.claims,
        largest: "memberships",
      });
    }
  }
  return breaches;
}
