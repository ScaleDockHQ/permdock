import type { Decision } from "./decision.ts";
import type { EvalEnv } from "./events.ts";
import type { DecideOptions } from "./permdock.ts";
import type { Permission } from "./permission-types.ts";
import type { Policy } from "./policy-types.ts";
import type { RelatedVerdict } from "./relations.ts";
import type { Subject } from "./subject.ts";

import { findPermission, listPermissions } from "./permission-registry.ts";

/** The signature of `evaluate`, passed in so this module never imports it. */
export type Evaluate = (
  policy: Policy,
  given: Subject,
  permission: Permission,
  data: unknown,
  options: DecideOptions,
  env: EvalEnv,
) => Decision;

export function alternativesFor(
  evaluate: Evaluate,
  policy: Policy,
  permission: Permission,
  subject: Subject,
  now: number,
  env: EvalEnv,
): Permission[] {
  const same = listPermissions(policy.permissions).filter(
    (leaf) =>
      leaf.resource === permission.resource && leaf.key !== permission.key,
  );
  return same.filter((leaf) => {
    const decision = evaluate(
      policy,
      subject,
      leaf,
      undefined,
      { trusted: true, call: "simulate", now },
      { ...env, emit: false, skipAlternatives: true, outcomeOnly: true },
    );
    return decision.outcome === "granted";
  });
}

export function inheritedVerdict(
  evaluate: Evaluate,
  policy: Policy,
  subject: Subject,
  resource: string,
  id: string,
  key: string,
  now: number,
  env: EvalEnv,
): RelatedVerdict {
  const leaf = findPermission(policy.permissions, key);
  const loaded = env.relations?.row({ resource, id });
  if (leaf === undefined || loaded === undefined) {
    return "relation-unavailable";
  }
  if (loaded === "pending" || loaded === "failed") {
    return "relation-unavailable";
  }
  if (loaded.row === null) {
    return false;
  }
  const decision = evaluate(
    policy,
    subject,
    leaf,
    loaded.row,
    { trusted: true, call: "simulate", now },
    { ...env, emit: false, skipAlternatives: true, outcomeOnly: true },
  );
  if (decision.outcome === "granted") {
    return true;
  }
  const reasons =
    decision.outcome === "denied"
      ? decision.denials.map((denial) => denial.reason)
      : [];
  return reasons.includes("relation-unavailable")
    ? "relation-unavailable"
    : reasons.includes("relation-depth")
      ? "relation-depth"
      : false;
}
