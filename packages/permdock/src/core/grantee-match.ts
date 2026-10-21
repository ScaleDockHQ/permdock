import type { Condition } from "../conditions/ast.ts";
import type { ResourceNode } from "./permission-types.ts";
import type { Subject } from "./subject.ts";

import { compact } from "./compact.ts";
import { inheritCondition, relationCondition } from "./grantee-conditions.ts";
import { type Grantee, type GranteeMatch, flattenGrantee } from "./grantee.ts";
import { type Scope, activeFor, scopeList } from "./scopes.ts";
import { isoAt } from "./time.ts";

export function combineWhere(
  left: Condition | undefined,
  right: Condition | undefined,
): Condition | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return { op: "and", conditions: [left, right] };
}

/**
 * Seats (`Membership.entitlements`) held through memberships that apply under
 * the active tenant.
 */
function seatsInTenant(
  subject: Subject,
  scopes: readonly Scope[] | undefined,
): readonly string[] {
  const principal = subject.principal;
  if (principal === null) {
    return [];
  }
  const list = scopeList(scopes);
  return (principal.memberships ?? []).flatMap((membership) =>
    membership.entitlements !== undefined &&
    activeFor(membership, list, principal.tenant)
      ? membership.entitlements
      : [],
  );
}

function matchOne(
  grantee: Grantee,
  subject: Subject,
  now: number,
  resource: ResourceNode | undefined,
  scopes: readonly Scope[] | undefined,
  resources: ReadonlyMap<string, ResourceNode> | undefined,
): GranteeMatch {
  switch (grantee.kind) {
    case "anyone":
      return { matched: true };
    case "authenticated":
      return subject.principal === null
        ? { matched: false, reason: "anonymous" }
        : { matched: true };
    case "plan": {
      if (subject.principal === null) {
        return { matched: false, reason: "anonymous" };
      }
      const plans = subject.principal.plans ?? [];
      return plans.includes(grantee.plan) ||
        seatsInTenant(subject, scopes).includes(grantee.plan)
        ? { matched: true }
        : { matched: false, reason: "not-entitled" };
    }
    case "actor": {
      if (subject.actor === undefined) {
        return { matched: false, reason: "no-grant" };
      }
      return subject.actor.kind === grantee.actor
        ? { matched: true }
        : { matched: false, reason: "no-grant" };
    }
    case "assurance": {
      if (subject.principal === null) {
        return { matched: false, reason: "anonymous" };
      }
      const principalAssurance = subject.principal.assurance;
      if (grantee.acr !== undefined && grantee.acr.length > 0) {
        const acr = principalAssurance?.acr;
        if (acr === undefined || !grantee.acr.includes(acr)) {
          return { matched: false, reason: "insufficient-user-authentication" };
        }
      }
      if (grantee.amr !== undefined && grantee.amr.length > 0) {
        const amr = principalAssurance?.amr ?? [];
        if (!grantee.amr.every((method) => amr.includes(method))) {
          return { matched: false, reason: "insufficient-user-authentication" };
        }
      }
      if (grantee.maxAge !== undefined) {
        const authTime = principalAssurance?.authTime;
        if (authTime === undefined || now - authTime > grantee.maxAge) {
          return { matched: false, reason: "insufficient-user-authentication" };
        }
      }
      return { matched: true };
    }
    case "relation": {
      if (subject.principal === null) {
        return { matched: false, reason: "anonymous" };
      }
      const where = relationCondition(grantee, resource, scopes, {
        resources,
        now: { date: isoAt(now * 1000) },
      });
      if (where === undefined && resource !== undefined) {
        return { matched: false, reason: "condition" };
      }
      return compact<GranteeMatch>({ matched: true, where });
    }
    case "inherit": {
      const where = inheritCondition(grantee, resource, resources);
      return where === undefined
        ? { matched: false, reason: "condition" }
        : { matched: true, where };
    }
    case "role": {
      if (subject.principal === null) {
        return { matched: false, reason: "anonymous" };
      }
      return { matched: true };
    }
    default: {
      const exhaustive: never = grantee;
      return unknownGrantee(exhaustive);
    }
  }
}

/**
 * A kind this build does not know, from a forged snapshot or a newer document,
 * never matches.
 */
function unknownGrantee(_grantee: never): GranteeMatch {
  return { matched: false, reason: "no-grant", unknown: true };
}

export function matchGrantee(
  to: Grantee | readonly Grantee[] | undefined,
  subject: Subject,
  now: number,
  resource: ResourceNode | undefined,
  scopes?: readonly Scope[],
  resources?: ReadonlyMap<string, ResourceNode>,
  unknownMatches = false,
): GranteeMatch {
  const items = flattenGrantee(to);
  if (items.length === 0) {
    return { matched: false, reason: "no-grant" };
  }
  let where: Condition | undefined;
  for (const item of items) {
    const result = matchOne(item, subject, now, resource, scopes, resources);
    if (!result.matched) {
      if (unknownMatches && result.unknown === true) {
        continue;
      }
      return result;
    }
    where = combineWhere(where, result.where);
  }
  return compact<GranteeMatch>({ matched: true, where });
}
