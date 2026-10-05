import type { Condition } from "../conditions/ast.ts";
import type { SnapshotGrant } from "./interfaces.ts";
import type { WhereResult } from "./permdock.ts";
import type { ResourceNode } from "./permissions.ts";
import type { Membership, Subject } from "./subject.ts";

import { bindConditionRefs } from "../conditions/bind.ts";
import { sole } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";
import { resourceRoleCondition } from "./grantee.ts";
import { type Scope, findScope, scopeChain, scopeIdOf } from "./scopes.ts";
import {
  activeFor,
  inTeam,
  isMembershipExpired,
  membershipField,
} from "./tenancy.ts";
import { isActive } from "./validity.ts";

const ALWAYS: Condition = { op: "eq", field: "_", value: true };

export type WhereScope = {
  readonly resource: string;
  /** The policy's resource graph; a snapshot carries none. */
  readonly resources?: ReadonlyMap<string, ResourceNode>;
  /** A `RelationSource` decides in process, so resource roles walk self-parents here too. */
  readonly graph?: boolean;
  readonly scopes: readonly Scope[];
  /** Whether `resource`'s rows are partitioned by the scope's key. */
  readonly partitioned: (scope: string, key: string) => boolean;
  /** The field of `resource` holding the scope's id, where it is not the scope's key. */
  readonly fieldOf?: (scope: string) => string | undefined;
  readonly tenant: string | undefined;
  readonly team: string | undefined;
  readonly now: number;
  readonly subject: Subject;
};

function eq(field: string, value: string | undefined): Condition {
  return value === undefined
    ? { op: "or", conditions: [] }
    : { op: "eq", field, value };
}

/** One equality per partitioning scope key on the membership's chain, outermost first. */
function namedFilters(
  membership: Membership,
  scope: WhereScope,
): Condition[] | null {
  if (
    findScope(scope.scopes, membership.scope ?? "") === undefined ||
    !inTeam(membership, scope.scopes, scope.team) ||
    !activeFor(membership, scope.scopes, scope.tenant) ||
    membership.scope === undefined
  ) {
    return null;
  }
  const filters: Condition[] = [];
  for (const name of scopeChain(scope.scopes, membership.scope).toReversed()) {
    const key = scope.fieldOf?.(name) ?? findScope(scope.scopes, name)?.key;
    if (key !== undefined && scope.partitioned(name, key)) {
      filters.push(eq(key, scopeIdOf(membership, name)));
    }
  }
  return filters;
}

/**
 * The row filters a grant's membership implies, or `null` when the grant
 * reaches no row in this scope (another tenant, no active tenant, expired).
 */
function scopeFilters(
  grant: SnapshotGrant,
  scope: WhereScope,
): Condition[] | null {
  if (grant.scope === undefined) {
    return [];
  }
  const membership = grant.membership;
  if (membership === undefined || isMembershipExpired(membership, scope.now)) {
    return null;
  }
  if (typeof grant.scope === "string") {
    return membership.scope === grant.scope
      ? namedFilters(membership, scope)
      : null;
  }
  const on = membership.on;
  if (on === undefined) {
    return null;
  }
  // As `matchScopedMembership`; without the graph only the row's own id.
  if (scope.resources === undefined) {
    return on.resource === grant.scope.resource &&
      on.resource === scope.resource
      ? [eq("id", on.id)]
      : null;
  }
  const roleResource = scope.resources.get(grant.scope.resource);
  if (
    on.resource !== grant.scope.resource &&
    membershipField(roleResource, on.resource, scope.resources) === undefined
  ) {
    return null;
  }
  const walked =
    scope.graph === true
      ? resourceRoleCondition(
          scope.resources.get(scope.resource),
          on.resource,
          [on.id],
          scope.resources,
        )
      : undefined;
  if (walked !== undefined) {
    return [walked];
  }
  const field = membershipField(
    scope.resources.get(scope.resource),
    on.resource,
    scope.resources,
  );
  return field === undefined ? null : [eq(field, on.id)];
}

function all(conditions: readonly Condition[]): Condition {
  if (conditions.length === 0) {
    return ALWAYS;
  }
  return sole(conditions) ?? { op: "and", conditions: [...conditions] };
}

function scopedCondition(
  grant: SnapshotGrant,
  scope: WhereScope,
): Condition | null | "always" {
  const filters = scopeFilters(grant, scope);
  if (filters === null) {
    return null;
  }
  const parts = grant.where === undefined ? filters : [...filters, grant.where];
  return parts.length === 0 ? "always" : all(parts);
}

/** Whether an unconditional `deny` removes every row `allow` could reach. */
function covers(
  deny: SnapshotGrant,
  allow: SnapshotGrant,
  scopes: readonly Scope[],
): boolean {
  if (deny.where !== undefined) {
    return false;
  }
  const denied = deny.membership;
  if (deny.scope === undefined || denied === undefined) {
    return deny.scope === undefined;
  }
  const allowed = allow.membership;
  if (allowed === undefined) {
    return false;
  }
  if (typeof deny.scope === "object") {
    return (
      typeof allow.scope === "object" &&
      denied.on?.resource === allowed.on?.resource &&
      denied.on?.id === allowed.on?.id
    );
  }
  if (typeof allow.scope !== "string" || allowed.scope === undefined) {
    return false;
  }
  // The deny's instance contains the allow's: same ids along the deny's chain.
  const chain = scopeChain(scopes, deny.scope);
  return (
    scopeChain(scopes, allowed.scope).includes(deny.scope) &&
    chain.every((name) => scopeIdOf(allowed, name) === scopeIdOf(denied, name))
  );
}

/**
 * The portable filter for one permission's grants: allows OR together, each
 * narrowed to its membership's tenant, team or resource; any applicable
 * portable deny is subtracted, and an unconditional one empties the result.
 */
function collect(
  grants: readonly SnapshotGrant[],
  scope: WhereScope,
): Omit<WhereResult, "subject"> {
  const none: WhereResult["condition"] = { op: "or", conditions: [] };
  const partial = grants.some((grant) => grant.portable === false);
  const denies: {
    readonly grant: SnapshotGrant;
    readonly condition: Condition;
  }[] = [];
  for (const grant of grants) {
    if (
      grant.effect !== "deny" ||
      grant.portable === false ||
      !isActive(grant.validity, scope.now)
    ) {
      continue;
    }
    const condition = scopedCondition(grant, scope);
    if (condition === "always") {
      return { condition: none, partial };
    }
    if (condition !== null) {
      denies.push({ grant, condition });
    }
  }
  const parts: Condition[] = [];
  for (const grant of grants) {
    if (
      grant.effect !== "allow" ||
      grant.portable === false ||
      !isActive(grant.validity, scope.now)
    ) {
      continue;
    }
    const condition = scopedCondition(grant, scope);
    if (
      condition === null ||
      denies.some((deny) => covers(deny.grant, grant, scope.scopes))
    ) {
      continue;
    }
    parts.push(
      all([
        ...(condition === "always" ? [] : [condition]),
        ...denies.map((deny): Condition => ({
          op: "not",
          condition: deny.condition,
        })),
      ]),
    );
  }
  if (parts.length === 0) {
    return { condition: none, partial };
  }
  return {
    condition: sole(parts) ?? { op: "or", conditions: parts },
    partial,
  };
}

/**
 * `collect`, with every subject ref bound to `scope.subject` and the subject
 * attached (not enumerable) for `memberOf`, which needs its memberships.
 */
export function whereFromGrants(
  grants: readonly SnapshotGrant[],
  scope: WhereScope,
): WhereResult {
  const { condition, partial } = collect(grants, scope);
  const result = {
    condition: bindConditionRefs(condition, scope.subject),
    partial,
  };
  Object.defineProperty(result, "subject", {
    value: scope.subject,
    enumerable: false,
  });
  Object.defineProperty(result, "scopes", {
    value: scope.scopes,
    enumerable: false,
  });
  if (scope.resources !== undefined) {
    Object.defineProperty(result, "resources", {
      value: scope.resources,
      enumerable: false,
    });
  }
  // SAFETY: result has condition and partial, plus subject, scopes and resources defined above.
  return freezeDeep(result) as WhereResult;
}
