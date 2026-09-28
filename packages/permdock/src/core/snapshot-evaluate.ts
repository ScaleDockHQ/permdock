import type {
  Decision,
  Denial,
  DenialReason,
  MatchedGrant,
} from './decision.ts';
import type { Snapshot, SnapshotGrant } from './interfaces.ts';
import type { DecideOptions, WhereResult } from './permdock.ts';
import type { Permission } from './permissions.ts';
import type { Subject } from './subject.ts';

import { evaluateCondition } from '../conditions/evaluate.ts';
import { requiresApproval } from './approval-required.ts';
import { compact } from './compact.ts';
import { coveredByDelegation, resourceIdOf } from './delegation.ts';
import { grantCoversField } from './fields.ts';
import { freezeDeep } from './freeze.ts';
import { matchGrantee } from './grantee.ts';
import { isMembershipExpired, nowSeconds } from './tenancy.ts';
import { decisionToken } from './token.ts';
import { whereFromGrants } from './where-scope.ts';

function isRowPair(
  value: unknown,
): value is { readonly current: unknown; readonly next: unknown } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'current' in value &&
    'next' in value
  );
}

function coveredByInclude(snapshot: Snapshot, permission: Permission): boolean {
  const include = snapshot.include;
  if (include === undefined || include.length === 0) {
    return true;
  }
  return include.some(
    (prefix) =>
      permission.key === prefix ||
      permission.key.startsWith(`${prefix}.`) ||
      permission.resource === prefix,
  );
}

export function rowId(data: unknown): string {
  if (data === null || typeof data !== 'object') {
    return '*';
  }
  const id = (data as Record<string, unknown>).id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : '*';
}

function rowField(data: unknown, key: string | undefined): unknown {
  if (key === undefined || data === null || typeof data !== 'object') {
    return undefined;
  }
  return Object.hasOwn(data, key)
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

function rowOutsideScope(
  snapshot: Snapshot,
  permission: Permission,
  data: unknown,
  kind: 'tenant' | 'team',
  expected: string | undefined,
): boolean {
  if (
    permission.kind !== 'instance' &&
    (data === null || typeof data !== 'object')
  ) {
    return false;
  }
  const value = rowField(data, snapshot.scopes?.[kind]?.key);
  const partitioned =
    value !== undefined ||
    snapshot.scopes?.partitioned?.[permission.resource]?.[kind] === true;
  return partitioned && value !== expected;
}

function scopeOk(
  snapshot: Snapshot,
  grant: SnapshotGrant,
  permission: Permission,
  subject: Subject,
  data: unknown,
  team: string | undefined,
  now: number,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DenialReason } {
  const scope = grant.scope;
  if (scope === undefined) {
    return { ok: true };
  }
  const principal = subject.principal;
  const membership = grant.membership;
  if (principal === null || membership === undefined) {
    return { ok: false, reason: 'no-membership' };
  }
  if (isMembershipExpired(membership, now)) {
    return { ok: false, reason: 'expired-membership' };
  }
  if (scope === 'tenant' || scope === 'team') {
    if (principal.tenant === undefined) {
      return { ok: false, reason: 'no-membership' };
    }
    if (membership.tenant !== principal.tenant) {
      return { ok: false, reason: 'tenant-mismatch' };
    }
    if (
      rowOutsideScope(snapshot, permission, data, 'tenant', membership.tenant)
    ) {
      return { ok: false, reason: 'tenant-mismatch' };
    }
    if (scope === 'tenant') {
      return { ok: true };
    }
    if (team !== undefined && membership.team !== team) {
      return { ok: false, reason: 'scope' };
    }
    if (rowOutsideScope(snapshot, permission, data, 'team', membership.team)) {
      return { ok: false, reason: 'scope' };
    }
    return { ok: true };
  }
  const on = membership.on;
  // A snapshot carries no parent graph: only a row of the membership's own
  // resource matches, by id; a descendant row fails closed.
  if (
    on === undefined ||
    on.resource !== scope.resource ||
    on.resource !== permission.resource
  ) {
    return { ok: false, reason: 'scope' };
  }
  if (on.id !== rowId(data)) {
    return { ok: false, reason: 'scope' };
  }
  return { ok: true };
}

function conditionOk(
  grant: SnapshotGrant,
  permission: Permission,
  current: unknown,
  next: unknown,
  subject: Subject,
  now: number,
): { readonly matched: boolean; readonly reason?: DenialReason } {
  if (grant.portable === false) {
    return { matched: false, reason: 'opaque-condition' };
  }
  if (grant.where !== undefined) {
    if (permission.kind === 'collection' || current === undefined) {
      return { matched: false, reason: 'condition' };
    }
    if (grant.where.op === 'opaque' || grant.check?.op === 'opaque') {
      return { matched: false, reason: 'opaque-condition' };
    }
    if (!evaluateCondition(grant.where, current, subject, now)) {
      return { matched: false, reason: 'condition' };
    }
  }
  const check = grant.check;
  if (check !== undefined) {
    if (check.op === 'opaque') {
      return { matched: false, reason: 'opaque-condition' };
    }
    if (next === undefined) {
      return { matched: false, reason: 'condition' };
    }
    if (!evaluateCondition(check, next, subject, now)) {
      return { matched: false, reason: 'condition' };
    }
  }
  return { matched: true };
}

export function evaluateSnapshot(
  snapshot: Snapshot,
  subject: Subject,
  permission: Permission,
  data: unknown,
  team: string | undefined,
  options: DecideOptions,
): Decision {
  const now = options.now ?? nowSeconds();
  if (!coveredByInclude(snapshot, permission)) {
    return freezeDeep({
      outcome: 'denied',
      denials: [{ role: null, reason: 'opaque-condition' }],
      alternatives: [],
    });
  }
  let current: unknown = data;
  let next: unknown = data;
  if (permission.kind === 'instance' && isRowPair(data)) {
    current = data.current;
    next = data.next;
  }
  if (permission.kind === 'collection') {
    current = undefined;
    next = data;
  }
  const denials: Denial[] = [];
  const allows: SnapshotGrant[] = [];
  for (const grant of snapshot.grants) {
    if (grant.permission !== permission.key) {
      continue;
    }
    const match = matchGrantee(grant.to, subject, now, undefined);
    if (!match.matched) {
      denials.push(
        compact({
          role: grant.role,
          reason: match.reason ?? 'no-grant',
          to: grant.to,
        }),
      );
      continue;
    }
    let scoped = scopeOk(
      snapshot,
      grant,
      permission,
      subject,
      permission.kind === 'instance' ? current : next,
      team,
      now,
    );
    if (scoped.ok && permission.kind === 'instance' && next !== current) {
      scoped = scopeOk(snapshot, grant, permission, subject, next, team, now);
    }
    if (!scoped.ok) {
      denials.push(
        compact({ role: grant.role, reason: scoped.reason, to: grant.to }),
      );
      continue;
    }
    if (grant.effect === 'deny' && grant.portable === false) {
      if (!grantCoversField(grant.fields, options.field, grant.effect)) {
        continue;
      }
      return freezeDeep({
        outcome: 'denied',
        denials: [{ role: grant.role, reason: 'opaque-condition' }],
        alternatives: [],
      });
    }
    const condition = conditionOk(
      grant,
      permission,
      current,
      next,
      subject,
      now,
    );
    if (!condition.matched) {
      denials.push({
        role: grant.role,
        reason: condition.reason ?? 'condition',
      });
      continue;
    }
    if (!grantCoversField(grant.fields, options.field, grant.effect)) {
      continue;
    }
    if (grant.effect === 'deny') {
      return freezeDeep({
        outcome: 'denied',
        denials: [{ role: grant.role, reason: 'deny' }],
        alternatives: [],
      });
    }
    allows.push(grant);
  }
  if (allows.length === 0) {
    return freezeDeep({
      outcome: 'denied',
      denials:
        denials.length > 0
          ? denials
          : [
              {
                role: null,
                reason: subject.principal === null ? 'anonymous' : 'no-grant',
              },
            ],
      alternatives: [],
    });
  }
  const miss = coveredByDelegation(
    permission,
    subject.delegation,
    resourceIdOf(current),
    subject.actor !== undefined,
  );
  if (miss !== undefined) {
    return freezeDeep({
      outcome: 'denied',
      denials: [{ role: null, reason: miss }],
      alternatives: [],
    });
  }
  const matched = allows[0]!;
  const token = decisionToken({
    key: permission.key,
    resourceId: permission.kind === 'collection' ? '*' : rowId(current),
    principal: subject.principal,
    actor: subject.actor,
    fingerprint: `snapshot:${String(snapshot.issuedAt)}`,
  });
  const grant = compact<MatchedGrant>({
    role: matched.role,
    permission: permission.key,
    to: matched.to,
    where: matched.where,
    check: matched.check,
    approval: matched.approval,
  });
  if (requiresApproval(matched.approval)) {
    return freezeDeep({
      outcome: 'approval-required',
      grant,
      reason: 'human',
      token,
    });
  }
  return freezeDeep({
    outcome: 'granted',
    subject,
    matched: grant,
    token,
  });
}

export function whereFromSnapshot(
  snapshot: Snapshot,
  subject: Subject,
  permission: Permission,
  team?: string,
): WhereResult {
  return whereFromGrants(
    snapshot.grants.filter((grant) => grant.permission === permission.key),
    {
      resource: permission.resource,
      scopes: snapshot.scopes,
      tenant: subject.principal?.tenant,
      team,
      now: nowSeconds(),
      subject,
    },
  );
}
