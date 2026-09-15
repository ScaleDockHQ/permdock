import type { Condition } from '../conditions/ast.ts';
import type {
  Decision,
  Denial,
  DenialReason,
  MatchedGrant,
} from './decision.ts';
import type { Grantee } from './grantee.ts';
import type { Snapshot, SnapshotGrant } from './interfaces.ts';
import type { DecideOptions, WhereResult } from './permdock.ts';
import type { Permission } from './permissions.ts';
import type { Subject } from './subject.ts';

import { evaluateCondition } from '../conditions/evaluate.ts';
import { compact } from './compact.ts';
import { coveredByDelegation, resourceIdOf } from './delegation.ts';
import { grantCoversField } from './fields.ts';
import { freezeDeep } from './freeze.ts';
import { matchGrantee } from './grantee.ts';
import { isMembershipExpired, nowSeconds } from './tenancy.ts';
import { decisionToken } from './token.ts';

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

function snapshotGrantee(grant: SnapshotGrant): Grantee | readonly Grantee[] {
  if (grant.to !== undefined) {
    return grant.to;
  }
  const scope =
    grant.scope === undefined
      ? 'global'
      : grant.scope === 'tenant' || grant.scope === 'team'
        ? grant.scope
        : grant.scope;
  return freezeDeep({
    kind: 'role' as const,
    role: grant.role ?? '',
    scope,
  });
}

function scopeOk(
  grant: SnapshotGrant,
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
  if (principal === null) {
    return { ok: false, reason: 'no-membership' };
  }
  const membership = grant.membership;
  if (membership !== undefined && isMembershipExpired(membership, now)) {
    return { ok: false, reason: 'expired-membership' };
  }
  if (scope === 'tenant') {
    if (principal.tenant === undefined) {
      return { ok: false, reason: 'no-membership' };
    }
    if (
      membership?.tenant !== undefined &&
      membership.tenant !== principal.tenant
    ) {
      return { ok: false, reason: 'tenant-mismatch' };
    }
    return { ok: true };
  }
  if (scope === 'team') {
    if (principal.tenant === undefined) {
      return { ok: false, reason: 'no-membership' };
    }
    if (team !== undefined && membership?.team !== team) {
      return { ok: false, reason: 'scope' };
    }
    if (
      membership?.tenant !== undefined &&
      membership.tenant !== principal.tenant
    ) {
      return { ok: false, reason: 'tenant-mismatch' };
    }
    return { ok: true };
  }
  const on = membership?.on;
  if (on === undefined || on.resource !== scope.resource) {
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
    const match = matchGrantee(snapshotGrantee(grant), subject, now, undefined);
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
    const scoped = scopeOk(grant, subject, current, team, now);
    if (!scoped.ok) {
      denials.push(
        compact({ role: grant.role, reason: scoped.reason, to: grant.to }),
      );
      continue;
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
    to: matched.to ?? snapshotGrantee(matched),
    where: matched.where,
    check: matched.check,
    approval: matched.approval,
  });
  if (matched.approval === 'human') {
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
  permission: Permission,
): WhereResult {
  const grants = snapshot.grants.filter(
    (grant) => grant.permission === permission.key,
  );
  const allows = grants.filter(
    (grant) => grant.effect === 'allow' && grant.portable !== false,
  );
  const denies = grants.filter(
    (grant) => grant.effect === 'deny' && grant.portable !== false,
  );
  const partial = grants.some((grant) => grant.portable === false);
  if (allows.length === 0) {
    return { condition: { op: 'or', conditions: [] }, partial };
  }
  const parts: Condition[] = allows.map((grant) => {
    let condition: Condition = grant.where ?? {
      op: 'eq',
      field: '_',
      value: true,
    };
    for (const denyGrant of denies) {
      if (denyGrant.where !== undefined) {
        condition = {
          op: 'and',
          conditions: [condition, { op: 'not', condition: denyGrant.where }],
        };
      }
    }
    return condition;
  });
  return {
    condition: parts.length === 1 ? parts[0]! : { op: 'or', conditions: parts },
    partial,
  };
}
