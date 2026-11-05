import type { Decision } from "./decision.ts";
import type { Permission } from "./permission-types.ts";
import type { Policy } from "./policy-types.ts";
import type { ExpandedSnapshot, SnapshotTypeLevel } from "./snapshot-types.ts";

import { compact } from "./compact.ts";
import { findPermission } from "./permission-registry.ts";
import { evaluateSnapshot } from "./snapshot-evaluate.ts";
import { subjectFromSnapshot } from "./snapshot-subject.ts";

/**
 * Whether a rowless answer could change without a new snapshot: a grant with a
 * `validity` or a membership with `expiresAt` flips with the clock.
 */
function clockDependent(snapshot: ExpandedSnapshot): boolean {
  return (
    snapshot.grants.some((entry) => entry.validity !== undefined) ||
    (snapshot.subject.principal?.memberships ?? []).some(
      (membership) => membership.expiresAt !== undefined,
    )
  );
}

function rowless(
  snapshot: ExpandedSnapshot,
  permission: Permission,
): Decision | null {
  try {
    return evaluateSnapshot(
      snapshot,
      subjectFromSnapshot(snapshot, undefined),
      permission,
      undefined,
      undefined,
      {},
    );
  } catch {
    /* v8 ignore next */
    return null;
  }
}

/**
 * The `typeLevel` table of `snapshot`: the answer of every permission it holds
 * an allow for, computed by the evaluator the client would run. A throw is a
 * denial, as in `can()`.
 */
export function typeLevelOf(
  policy: Policy,
  snapshot: ExpandedSnapshot,
): SnapshotTypeLevel | undefined {
  if (clockDependent(snapshot)) {
    return undefined;
  }
  const granted: string[] = [];
  const approval: string[] = [];
  const endpoint: string[] = [];
  const keys = new Set(
    snapshot.grants
      .filter((entry) => entry.effect === "allow")
      .map((entry) => entry.permission),
  );
  for (const key of [...keys].toSorted()) {
    const permission = findPermission(policy.permissions, key);
    const decision =
      permission === undefined ? null : rowless(snapshot, permission);
    if (decision === null) {
      continue;
    }
    switch (decision.outcome) {
      case "granted":
        granted.push(key);
        break;
      case "approval-required":
        approval.push(key);
        break;
      case "denied":
        if (
          decision.denials.some(
            (denial) => denial.reason === "opaque-condition",
          )
        ) {
          endpoint.push(key);
        }
        break;
      /* v8 ignore next 4 */
      default: {
        const exhausted: never = decision;
        return exhausted;
      }
    }
  }
  return compact<SnapshotTypeLevel>({
    granted,
    approval: approval.length === 0 ? undefined : approval,
    endpoint: endpoint.length === 0 ? undefined : endpoint,
  });
}
