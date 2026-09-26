import type { Condition } from '../conditions/ast.ts';
import type { Snapshot, SnapshotGrant } from './interfaces.ts';
import type { WhereResult } from './permdock.ts';
import type { ResourceNode } from './permissions.ts';
import type { Membership, Subject } from './subject.ts';

import { bindConditionRefs } from '../conditions/bind.ts';
import { freezeDeep } from './freeze.ts';
import { isMembershipExpired, membershipField } from './tenancy.ts';

const ALWAYS: Condition = { op: 'eq', field: '_', value: true };

export type WhereScope = {
  readonly resource: string;
  /** The policy's resource graph; a snapshot carries none. */
  readonly resources?: ReadonlyMap<string, ResourceNode>;
  readonly scopes: Snapshot['scopes'];
  readonly tenant: string | undefined;
  readonly team: string | undefined;
  readonly now: number;
  readonly subject: Subject;
};

function eq(field: string, value: string | undefined): Condition {
  return value === undefined
    ? { op: 'or', conditions: [] }
    : { op: 'eq', field, value };
}

function tenantFilters(
  membership: Membership,
  scope: WhereScope,
  withTeam: boolean,
): Condition[] | null {
  if (scope.tenant === undefined || membership.tenant !== scope.tenant) {
    return null;
  }
  if (withTeam && scope.team !== undefined && membership.team !== scope.team) {
    return null;
  }
  const partitioned = scope.scopes?.partitioned?.[scope.resource];
  const filters: Condition[] = [];
  const tenantKey = scope.scopes?.tenant?.key;
  if (partitioned?.tenant === true && tenantKey !== undefined) {
    filters.push(eq(tenantKey, membership.tenant));
  }
  const teamKey = scope.scopes?.team?.key;
  if (withTeam && partitioned?.team === true && teamKey !== undefined) {
    filters.push(eq(teamKey, membership.team));
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
  if (grant.scope === 'tenant' || grant.scope === 'team') {
    return tenantFilters(membership, scope, grant.scope === 'team');
  }
  const on = membership.on;
  if (on === undefined) {
    return null;
  }
  // As `matchScopedMembership`; without the graph only the row's own id.
  if (scope.resources === undefined) {
    return on.resource === grant.scope.resource &&
      on.resource === scope.resource
      ? [eq('id', on.id)]
      : null;
  }
  const roleResource = scope.resources.get(grant.scope.resource);
  if (
    on.resource !== grant.scope.resource &&
    membershipField(roleResource, on.resource, scope.resources) === undefined
  ) {
    return null;
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
  return conditions.length === 1
    ? conditions[0]!
    : { op: 'and', conditions: [...conditions] };
}

function scopedCondition(
  grant: SnapshotGrant,
  scope: WhereScope,
): Condition | null | 'always' {
  const filters = scopeFilters(grant, scope);
  if (filters === null) {
    return null;
  }
  const parts = grant.where === undefined ? filters : [...filters, grant.where];
  return parts.length === 0 ? 'always' : all(parts);
}

/** Whether an unconditional `deny` removes every row `allow` could reach. */
function covers(deny: SnapshotGrant, allow: SnapshotGrant): boolean {
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
  if (typeof deny.scope === 'object') {
    return (
      typeof allow.scope === 'object' &&
      denied.on?.resource === allowed.on?.resource &&
      denied.on?.id === allowed.on?.id
    );
  }
  return (
    typeof allow.scope !== 'object' &&
    denied.tenant === allowed.tenant &&
    (deny.scope === 'tenant' || denied.team === allowed.team)
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
): Omit<WhereResult, 'subject'> {
  const none: WhereResult['condition'] = { op: 'or', conditions: [] };
  const partial = grants.some((grant) => grant.portable === false);
  const denies: {
    readonly grant: SnapshotGrant;
    readonly condition: Condition;
  }[] = [];
  for (const grant of grants) {
    if (grant.effect !== 'deny' || grant.portable === false) {
      continue;
    }
    const condition = scopedCondition(grant, scope);
    if (condition === 'always') {
      return { condition: none, partial };
    }
    if (condition !== null) {
      denies.push({ grant, condition });
    }
  }
  const parts: Condition[] = [];
  for (const grant of grants) {
    if (grant.effect !== 'allow' || grant.portable === false) {
      continue;
    }
    const condition = scopedCondition(grant, scope);
    if (
      condition === null ||
      denies.some((deny) => covers(deny.grant, grant))
    ) {
      continue;
    }
    parts.push(
      all([
        ...(condition === 'always' ? [] : [condition]),
        ...denies.map((deny): Condition => ({
          op: 'not',
          condition: deny.condition,
        })),
      ]),
    );
  }
  if (parts.length === 0) {
    return { condition: none, partial };
  }
  return {
    condition: parts.length === 1 ? parts[0]! : { op: 'or', conditions: parts },
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
  Object.defineProperty(result, 'subject', {
    value: scope.subject,
    enumerable: false,
  });
  return freezeDeep(result) as WhereResult;
}
