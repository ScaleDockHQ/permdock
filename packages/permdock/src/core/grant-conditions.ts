import type { RelatedCondition } from "../conditions/ast.ts";
import type { DenialReason, MatchedGrant } from "./decision.ts";
import type { DecisionEvent } from "./event-types.ts";
import type { Permission } from "./permission-types.ts";
import type { Grant, Policy } from "./policy-types.ts";
import type { RelatedVerdict, RelationReader } from "./relations.ts";
import type { Subject } from "./subject.ts";

import { evaluateCondition } from "../conditions/evaluate.ts";
import { compact } from "./compact.ts";
import { resolveRelated } from "./relation-walk.ts";
import { isThenable } from "./thenable.ts";

export function evaluateGrantCondition(
  grant: Grant,
  permission: Permission,
  current: unknown,
  next: unknown,
  subject: Subject,
  now: number,
  scopes: Policy["scopes"],
  relations: RelationReader | undefined,
  permitted?: (
    resource: string,
    id: string,
    permission: string,
  ) => RelatedVerdict,
): {
  readonly matched: boolean;
  readonly reason?: DenialReason;
  readonly cause?: unknown;
} {
  // Any graph read the instance could not answer, and any opaque node, fails the
  // grant whatever the rest of the condition says, so `not` and `or` cannot
  // turn it into a match.
  let unknown:
    | "relation-depth"
    | "relation-unavailable"
    | "opaque-condition"
    | undefined;
  const onOpaque = (): void => {
    unknown ??= "opaque-condition";
  };
  const related = (condition: RelatedCondition, row: unknown): boolean => {
    if (relations === undefined) {
      unknown ??= "relation-unavailable";
      return false;
    }
    const verdict = resolveRelated(
      condition,
      row,
      subject,
      now,
      relations,
      permitted,
    );
    if (verdict === "relation-depth" || verdict === "relation-unavailable") {
      unknown ??= verdict;
      return false;
    }
    return verdict;
  };
  if (!grant.portable && grant.closure !== undefined) {
    try {
      const result = grant.closure(next ?? current, {
        subject,
        actor: subject.actor,
        delegation: subject.delegation,
        context: subject.context,
      });
      if (isThenable(result)) {
        return { matched: false, reason: "closure-error", cause: result };
      }
      return { matched: result === true };
    } catch (error) {
      return { matched: false, reason: "closure-error", cause: error };
    }
  }
  // An allow needs `where` on the current row and `check` on the next one; a
  // deny applies when either does, so neither moving a row out of a deny nor
  // into one gets past it (the RESTRICTIVE policy's USING and WITH CHECK).
  const deny = grant.effect === "deny";
  let whereMatched: boolean | undefined;
  if (grant.where !== undefined) {
    if (permission.kind === "collection") {
      return { matched: false, reason: "condition" };
    }
    if (current === undefined) {
      return { matched: false, reason: "condition" };
    }
    if (grant.where.op === "opaque" || grant.check?.op === "opaque") {
      return { matched: false, reason: "opaque-condition" };
    }
    whereMatched = evaluateCondition(
      grant.where,
      current,
      subject,
      now,
      scopes,
      related,
      onOpaque,
    );
    if (unknown !== undefined) {
      return { matched: false, reason: unknown };
    }
    if (whereMatched && deny) {
      return { matched: true };
    }
    if (!whereMatched && !deny) {
      return { matched: false, reason: "condition" };
    }
  }
  const checkCondition =
    grant.check ?? (permission.action === "update" ? grant.where : undefined);
  if (checkCondition === undefined && whereMatched === false) {
    return { matched: false, reason: "condition" };
  }
  if (checkCondition !== undefined) {
    if (checkCondition.op === "opaque") {
      return { matched: false, reason: "opaque-condition" };
    }
    if (next === undefined) {
      return { matched: false, reason: "condition" };
    }
    const matched = evaluateCondition(
      checkCondition,
      next,
      subject,
      now,
      scopes,
      related,
      onOpaque,
    );
    if (unknown !== undefined) {
      return { matched: false, reason: unknown };
    }
    if (!matched) {
      return { matched: false, reason: "condition" };
    }
  }
  return { matched: true };
}

/** A grant whose condition could not be answered; a deny with one denies. */
export function isUnevaluable(reason: DenialReason | undefined): boolean {
  return (
    reason === "relation-depth" ||
    reason === "relation-unavailable" ||
    reason === "closure-error" ||
    reason === "opaque-condition"
  );
}

export function shouldConsumeQuota(
  call: DecisionEvent["call"] | undefined,
  simulated: boolean,
): boolean {
  if (simulated) {
    return false;
  }
  switch (call) {
    case "can":
    case "filter":
    case "simulate":
    case "explain":
      return false;
    case "decide":
    case "assert":
    case "endpoint":
    case "adapter":
    case "approval":
    case undefined:
      return true;
    default: {
      const exhaustive: never = call;
      return exhaustive;
    }
  }
}

export function isDelegatedPermission(
  policy: Policy,
  permission: Permission,
): boolean {
  const providers = policy.providers;
  if (providers === undefined || providers.length === 0) {
    return false;
  }
  for (const provider of providers) {
    if (provider.handles(permission)) {
      return true;
    }
  }
  return false;
}

/** The `MatchedGrant` view of a grant, shared by `matched` and the trace. */
export function matchedOf(
  grant: Grant,
  permissionKey: string,
  breakGlass?: true,
): MatchedGrant {
  return compact<MatchedGrant>({
    role: grant.role,
    permission: permissionKey,
    name: grant.name,
    meta: grant.meta,
    to: grant.to,
    where: grant.where,
    check: grant.check,
    approval: grant.approval,
    hosted: grant.hosted,
    breakGlass,
  });
}
