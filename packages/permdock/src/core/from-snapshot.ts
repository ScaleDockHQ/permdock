import type { Condition } from '../conditions/ast.ts';
import type {
  Decision,
  Denial,
  DenialReason,
  MatchedGrant,
} from './decision.ts';
import type { SnapshotGrant, SnapshotV2 } from './interfaces.ts';
import type { DecideOptions, PermDock, WhereResult } from './permdock.ts';
import type { Permission } from './permissions.ts';
import type { Membership, Principal, Subject } from './subject.ts';

import { evaluateCondition } from '../conditions/evaluate.ts';
import { isArazzoSimulateInput, simulateArazzo } from './arazzo.ts';
import { compact } from './compact.ts';
import { coveredByDelegation, resourceIdOf } from './delegation.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  approvalMessage,
  deniedMessage,
} from './errors.ts';
import { grantCoversField, pickVisible } from './fields.ts';
import { freezeDeep } from './freeze.ts';
import {
  isMembershipExpired,
  nowSeconds,
  resolveActiveTenant,
} from './tenancy.ts';
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

function coveredByInclude(
  snapshot: SnapshotV2,
  permission: Permission,
): boolean {
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

function rowId(data: unknown): string {
  if (data === null || typeof data !== 'object') {
    return '*';
  }
  const id = (data as Record<string, unknown>).id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : '*';
}

function subjectFromSnapshot(
  snapshot: SnapshotV2,
  tenant: string | undefined,
): Subject {
  const principal = snapshot.subject.principal;
  const nextTenant =
    principal === null
      ? undefined
      : tenant === undefined
        ? principal.tenant
        : resolveActiveTenant(
            compact<Principal>({
              ...principal,
              memberships: principal.memberships ?? [],
            }),
            tenant,
          );
  return freezeDeep(
    compact<Subject>({
      principal:
        principal === null
          ? null
          : compact<Principal>({
              ...principal,
              tenant: nextTenant,
            }),
      delegation: snapshot.subject.delegation,
      context: snapshot.subject.context,
      expiresAt: snapshot.expiresAt,
    }),
  );
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

function evaluateSnapshot(
  snapshot: SnapshotV2,
  subject: Subject,
  permission: Permission,
  data: unknown,
  team: string | undefined,
  options: DecideOptions,
): Decision {
  const now = options.now ?? nowSeconds();
  if (subject.principal === null) {
    return freezeDeep({
      outcome: 'denied',
      denials: [{ role: null, reason: 'anonymous' }],
      alternatives: [],
    });
  }
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
    const scoped = scopeOk(grant, subject, current, team, now);
    if (!scoped.ok) {
      denials.push({ role: grant.role, reason: scoped.reason });
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
        denials.length > 0 ? denials : [{ role: null, reason: 'no-grant' }],
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
    subject: {
      ...subject,
      principal: subject.principal,
    },
    matched: grant,
    token,
  });
}

function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  const id = permission.kind === 'collection' ? undefined : rowId(data);
  return id === undefined || id === '*'
    ? { type: permission.resource }
    : { type: permission.resource, id };
}

function heldRoles(subject: Subject, tenant: string | undefined): string[] {
  const names = new Set<string>(subject.principal?.roles ?? []);
  for (const membership of subject.principal?.memberships ?? []) {
    if (tenant !== undefined && membership.tenant !== tenant) {
      continue;
    }
    for (const role of membership.roles) {
      names.add(role);
    }
  }
  return [...names];
}

function whereFromSnapshot(
  snapshot: SnapshotV2,
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

export function fromSnapshot(
  snapshot: SnapshotV2,
  options: { readonly tenant?: string; readonly team?: string } = {},
): PermDock {
  const subject = subjectFromSnapshot(snapshot, options.tenant);
  const team = options.team;

  const run = (
    permission: Permission,
    data?: unknown,
    decideOptions: DecideOptions = {},
  ): Decision =>
    evaluateSnapshot(snapshot, subject, permission, data, team, decideOptions);

  const decide = ((
    permission: Permission,
    data?: unknown,
    decideOptions: DecideOptions = {},
  ): Decision => run(permission, data, decideOptions)) as PermDock['decide'];

  const can = ((
    permission: Permission,
    data?: unknown,
    decideOptions?: DecideOptions,
  ): boolean =>
    run(permission, data, decideOptions).outcome ===
    'granted') as PermDock['can'];

  const assert = ((
    permission: Permission,
    data?: unknown,
    decideOptions?: DecideOptions,
  ) => {
    const decision = run(permission, data, decideOptions);
    if (decision.outcome === 'granted') {
      return decision;
    }
    if (decision.outcome === 'approval-required') {
      throw new PermDockApprovalRequiredError({
        decision,
        permission: permission.key,
        scope: permission.scope,
        resource: resourceRef(permission, data),
        message: approvalMessage(
          permission.key,
          decision.reason,
          decision.token,
        ),
      });
    }
    throw new PermDockDeniedError({
      decision,
      permission: permission.key,
      scope: permission.scope,
      resource: resourceRef(permission, data),
      subject,
      message: deniedMessage(
        permission.key,
        subject.principal?.id,
        decision.denials,
        [],
      ),
    });
  }) as PermDock['assert'];

  const instance: PermDock = {
    can,
    decide,
    assert,
    filter<T>(
      permission: Permission<string, T, 'instance'>,
      rows: readonly T[],
      decideOptions?: DecideOptions,
    ): T[] {
      return rows.filter((row) => can(permission, row, decideOptions) === true);
    },
    pick<T>(
      permission: Permission<string, T, 'instance'>,
      row: T,
      decideOptions?: DecideOptions,
    ): Partial<T> {
      if (row === null || typeof row !== 'object') {
        return {};
      }
      if (can(permission, row, decideOptions) !== true) {
        return {};
      }
      return pickVisible(row, (field) => {
        const next = compact<DecideOptions>({ ...decideOptions, field });
        return can(permission, row, next) === true;
      });
    },
    where(permission) {
      return whereFromSnapshot(snapshot, permission);
    },
    simulate: ((input: unknown) => {
      if (Array.isArray(input)) {
        return (input as readonly (readonly [Permission, unknown?])[]).map(
          ([permission, data]) => run(permission, data),
        );
      }
      if (isArazzoSimulateInput(input)) {
        return simulateArazzo(input, input.permissions, (permission, data) =>
          run(permission, data),
        );
      }
      const preview = input as {
        readonly roles?: readonly string[];
        readonly memberships?: readonly Membership[];
        readonly tenant?: string;
      };
      const next: SnapshotV2 = freezeDeep({
        ...snapshot,
        simulated: true as const,
        subject: {
          ...snapshot.subject,
          principal:
            snapshot.subject.principal === null
              ? null
              : compact<NonNullable<SnapshotV2['subject']['principal']>>({
                  ...snapshot.subject.principal,
                  roles: preview.roles ?? snapshot.subject.principal.roles,
                  memberships:
                    preview.memberships ??
                    snapshot.subject.principal.memberships,
                  tenant: preview.tenant ?? snapshot.subject.principal.tenant,
                }),
        },
      });
      return fromSnapshot(next, options);
    }) as PermDock['simulate'],
    snapshot() {
      return snapshot;
    },
    on() {
      return (): void => undefined;
    },
    tenant(id: string): PermDock {
      return fromSnapshot(snapshot, compact({ tenant: id, team }));
    },
    team(id: string): PermDock {
      return fromSnapshot(
        snapshot,
        compact({ tenant: options.tenant, team: id }),
      );
    },
    memberships() {
      return subject.principal?.memberships ?? [];
    },
    tenants() {
      return snapshot.tenants;
    },
    roles(query?: { readonly tenant?: string }) {
      return heldRoles(subject, query?.tenant ?? subject.principal?.tenant);
    },
    assignable() {
      return [];
    },
    subject,
  };
  return Object.freeze(instance);
}

export function emptySnapshot(): SnapshotV2 {
  return freezeDeep({
    v: 2 as const,
    issuedAt: 0,
    subject: { principal: null, context: {} },
    roles: [],
    grants: [],
    tenants: [],
  });
}
