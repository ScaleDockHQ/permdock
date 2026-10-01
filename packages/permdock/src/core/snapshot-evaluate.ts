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
import { type Scope, scopeList } from './scopes.ts';
import {
  activeFor,
  inTeam,
  isMembershipExpired,
  nowSeconds,
  rowInScope,
} from './tenancy.ts';
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
  // SAFETY: data is a non-null object checked above; the read id stays unknown and is checked below.
  const id = (data as Record<string, unknown>)['id'];
  return typeof id === 'string' || typeof id === 'number' ? String(id) : '*';
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
  if (typeof scope === 'string') {
    const scopes = scopeList(snapshot.scopes);
    // A scope the snapshot does not list has no row keys to check: fail closed.
    if (
      membership.scope !== scope ||
      !scopes.some((entry) => entry.name === scope)
    ) {
      return { ok: false, reason: 'scope' };
    }
    if (!activeFor(membership, scopes, principal.tenant)) {
      return {
        ok: false,
        reason:
          principal.tenant === undefined ? 'no-membership' : 'tenant-mismatch',
      };
    }
    if (!inTeam(membership, scopes, team)) {
      return { ok: false, reason: 'scope' };
    }
    if (
      permission.kind !== 'instance' &&
      (data === null || typeof data !== 'object')
    ) {
      return { ok: true };
    }
    const partitioned = (name: string): boolean =>
      snapshot.scopes
        ?.find((entry) => entry.name === name)
        ?.resources?.includes(permission.resource) === true;
    // An instance action with no row object still fails a partitioned scope.
    const row: object = data !== null && typeof data === 'object' ? data : {};
    return rowInScope(membership, scopes, row, partitioned);
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
  scopes: readonly Scope[],
): { readonly matched: boolean; readonly reason?: DenialReason } {
  let opaqueReached = false;
  const onOpaque = (): void => {
    opaqueReached = true;
  };
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
    const matched = evaluateCondition(
      grant.where,
      current,
      subject,
      now,
      scopes,
      undefined,
      onOpaque,
    );
    if (opaqueReached) {
      return { matched: false, reason: 'opaque-condition' };
    }
    if (!matched) {
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
    const matched = evaluateCondition(
      check,
      next,
      subject,
      now,
      scopes,
      undefined,
      onOpaque,
    );
    if (opaqueReached) {
      return { matched: false, reason: 'opaque-condition' };
    }
    if (!matched) {
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
      scopeList(snapshot.scopes),
    );
    if (
      !condition.matched &&
      grant.effect === 'deny' &&
      condition.reason === 'opaque-condition' &&
      grantCoversField(grant.fields, options.field, grant.effect)
    ) {
      return freezeDeep({
        outcome: 'denied',
        denials: [{ role: grant.role, reason: 'opaque-condition' }],
        alternatives: [],
      });
    }
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
  const [matched] = allows;
  if (matched === undefined) {
    for (const entry of snapshot.notEntitled ?? []) {
      if (entry.permission === permission.key) {
        denials.push({
          role: entry.role,
          reason: 'not-entitled',
          to: entry.to,
        });
      }
    }
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
      scopes: scopeList(snapshot.scopes),
      partitioned: (name) =>
        snapshot.scopes
          ?.find((entry) => entry.name === name)
          ?.resources?.includes(permission.resource) === true,
      tenant: subject.principal?.tenant,
      team,
      now: nowSeconds(),
      subject,
    },
  );
}
