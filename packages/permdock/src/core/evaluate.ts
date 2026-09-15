import type {
  Decision,
  Denial,
  DenialReason,
  MatchedGrant,
} from './decision.ts';
import type { AuthEvent, DecisionEvent, RoleSource } from './interfaces.ts';
import type { DecideOptions, RowPair } from './permdock.ts';
import type { Permission } from './permissions.ts';
import type { Grant, Policy } from './policy.ts';
import type { CustomRole, Membership, Subject } from './subject.ts';

import { evaluateCondition } from '../conditions/evaluate.ts';
import { compact } from './compact.ts';
import { coveredByDelegation, resourceIdOf } from './delegation.ts';
import { PermDockValidationError } from './errors.ts';
import { type EvalEnv, emitSafe, finish } from './events.ts';
import { grantCoversField } from './fields.ts';
import { freezeDeep } from './freeze.ts';
import { combineWhere, flattenGrantee, matchGrantee } from './grantee.ts';
import { applyQuota } from './limits.ts';
import { getResource, listPermissions } from './permissions.ts';
import { matchScopedMembership, nowSeconds } from './tenancy.ts';
import { isThenable } from './thenable.ts';
import { decisionToken } from './token.ts';
import { validateBoundary } from './validation.ts';
import { listRoles } from './vocabulary.ts';

function isRowPair(value: unknown): value is RowPair<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'current' in value &&
    'next' in value
  );
}

export function customRolesFor(
  source: RoleSource | undefined,
  tenants: readonly string[],
  auth: AuthEvent[],
): CustomRole[] | Promise<CustomRole[]> {
  if (source === undefined) {
    return [];
  }
  const loaded: (CustomRole[] | Promise<CustomRole[]>)[] = [];
  for (const tenant of tenants) {
    try {
      loaded.push(source.rolesFor(tenant));
    } catch {
      auth.push({ reason: 'source-threw', source: 'customRoles' });
      loaded.push([]);
    }
  }
  if (loaded.some((item) => isThenable(item))) {
    return Promise.all(
      loaded.map((item) =>
        Promise.resolve(item).catch(() => {
          auth.push({ reason: 'source-threw', source: 'customRoles' });
          return [] as CustomRole[];
        }),
      ),
    ).then((lists) => lists.flat());
  }
  return (loaded as CustomRole[][]).flat();
}

export function expandRoleNames(
  names: readonly string[],
  declared: ReadonlySet<string>,
  custom: readonly CustomRole[],
): { readonly roles: readonly string[]; readonly unknown: readonly string[] } {
  const resolved = new Set<string>();
  const unknown: string[] = [];
  for (const name of names) {
    if (declared.has(name)) {
      resolved.add(name);
      continue;
    }
    const customRole = custom.find((item) => item.name === name);
    if (customRole === undefined) {
      unknown.push(name);
      continue;
    }
    for (const included of customRole.includes) {
      if (declared.has(included)) {
        resolved.add(included);
      }
    }
  }
  return { roles: [...resolved], unknown };
}

export function declaredRoleNames(policy: Policy): Set<string> {
  const names = new Set(policy.roles.map((role) => role.name));
  for (const leaf of listRoles(policy.vocabulary?.roles)) {
    names.add(leaf.key);
  }
  return names;
}

export function grantList(policy: Policy): readonly Grant[] {
  if (policy.grants !== undefined && policy.grants.length > 0) {
    return policy.grants;
  }
  return policy.roles.flatMap((role) => role.grants);
}

function alternativesFor(
  policy: Policy,
  permission: Permission,
  subject: Subject,
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
      { trusted: true, source: 'decide' },
      { ...env, emit: false, skipAlternatives: true },
    );
    return decision.outcome === 'granted';
  });
}

function evaluateGrantCondition(
  grant: Grant,
  permission: Permission,
  current: unknown,
  next: unknown,
  subject: Subject,
  now: number,
): {
  readonly matched: boolean;
  readonly reason?: DenialReason;
  readonly cause?: unknown;
} {
  if (!grant.portable && grant.closure !== undefined) {
    try {
      const result = grant.closure(next ?? current, {
        subject,
        actor: subject.actor,
        delegation: subject.delegation,
        context: subject.context,
      });
      if (isThenable(result)) {
        return { matched: false, reason: 'closure-error', cause: result };
      }
      return { matched: result === true };
    } catch (error) {
      return { matched: false, reason: 'closure-error', cause: error };
    }
  }
  if (grant.where !== undefined) {
    if (permission.kind === 'collection') {
      return { matched: false, reason: 'condition' };
    }
    if (current === undefined) {
      return { matched: false, reason: 'condition' };
    }
    if (grant.where.op === 'opaque' || grant.check?.op === 'opaque') {
      return { matched: false, reason: 'opaque-condition' };
    }
    if (!evaluateCondition(grant.where, current, subject, now)) {
      return { matched: false, reason: 'condition' };
    }
  }
  const checkCondition =
    grant.check ?? (permission.action === 'update' ? grant.where : undefined);
  if (checkCondition !== undefined) {
    if (checkCondition.op === 'opaque') {
      return { matched: false, reason: 'opaque-condition' };
    }
    if (next === undefined) {
      return { matched: false, reason: 'condition' };
    }
    if (!evaluateCondition(checkCondition, next, subject, now)) {
      return { matched: false, reason: 'condition' };
    }
  }
  return { matched: true };
}

function shouldConsumeQuota(
  source: DecisionEvent['source'] | undefined,
  simulated: boolean,
): boolean {
  if (simulated) {
    return false;
  }
  switch (source) {
    case 'can':
    case 'filter':
    case 'simulate':
      return false;
    case 'decide':
    case 'assert':
    case 'endpoint':
    case 'adapter':
    case 'approval':
    case undefined:
      return true;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function isDelegatedPermission(
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

export function evaluate(
  policy: Policy,
  subject: Subject,
  permission: Permission,
  data: unknown,
  options: DecideOptions,
  env: EvalEnv,
): Decision {
  const now = options.now ?? nowSeconds();
  const trusted = options.trusted ?? true;
  const resource = getResource(policy.permissions, permission.resource);
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
  try {
    if (permission.kind === 'instance' || data !== undefined) {
      const validated = validateBoundary(
        permission,
        resource,
        permission.kind === 'instance' && isRowPair(data) ? data.current : data,
        policy.validate,
        trusted,
        options.boundary ?? 'manual',
      );
      if (permission.kind === 'instance' && isRowPair(data)) {
        current = validated;
        next = validateBoundary(
          permission,
          resource,
          data.next,
          policy.validate,
          trusted,
          options.boundary ?? 'manual',
        );
      } else if (permission.kind === 'instance') {
        current = validated;
        next = validated;
      } else {
        next = validated;
      }
    }
  } catch (error) {
    if (
      error instanceof PermDockValidationError &&
      error.code === 'invalid-data'
    ) {
      const decision: Decision = freezeDeep({
        outcome: 'denied',
        denials: [{ role: null, reason: 'validation', detail: error }],
        alternatives: [],
      });
      finish(
        policy,
        subject,
        permission,
        current,
        decision,
        options,
        env,
        trusted,
      );
      return decision;
    }
    throw error;
  }

  if (isDelegatedPermission(policy, permission)) {
    const decision: Decision = freezeDeep({
      outcome: 'denied',
      denials: [
        {
          role: null,
          reason: 'pdp-unavailable',
          detail: 'use permdock/pdp createPermDock',
        },
      ],
      alternatives: [],
    });
    finish(
      policy,
      subject,
      permission,
      current,
      decision,
      options,
      env,
      trusted,
    );
    return decision;
  }

  const declared = declaredRoleNames(policy);
  const principalRoles = subject.principal?.roles ?? [];
  const globalNames = expandRoleNames(
    principalRoles,
    declared,
    env.customRoles,
  );
  if (subject.principal !== null && globalNames.unknown.length > 0) {
    emitSafe(
      env.listeners.auth as unknown as Set<(payload: unknown) => void>,
      { reason: 'unknown-role', source: 'roles' } satisfies AuthEvent,
      env.listeners,
    );
  }

  const denials: Denial[] = [];
  const allows: { readonly grant: Grant; readonly membership?: Membership }[] =
    [];
  const matchingRoles = new Set<string>(globalNames.roles);

  for (const membership of subject.principal?.memberships ?? []) {
    if (env.team !== undefined && membership.team !== env.team) {
      continue;
    }
    const expanded = expandRoleNames(
      membership.roles,
      declared,
      env.customRoles,
    );
    for (const name of expanded.roles) {
      matchingRoles.add(name);
    }
    for (const name of expanded.unknown) {
      denials.push({ role: name, reason: 'unknown-role' });
    }
  }

  for (const grant of grantList(policy)) {
    if (grant.permission.key !== permission.key) {
      continue;
    }
    const displayRole = grant.role;
    const granteeMatch = matchGrantee(grant.to, subject, now, resource);
    if (!granteeMatch.matched) {
      denials.push({
        role: displayRole,
        reason: granteeMatch.reason ?? 'no-grant',
      });
      continue;
    }
    const roleItems = flattenGrantee(grant.to).filter(
      (item) => item.kind === 'role',
    );
    let scopeMembership: Membership | undefined;
    let roleOk = roleItems.length === 0;
    if (roleItems.length > 0) {
      if (subject.principal === null) {
        denials.push({ role: displayRole, reason: 'anonymous' });
        continue;
      }
      let allHeld = true;
      for (const roleItem of roleItems) {
        const held =
          roleItem.scope === 'global'
            ? globalNames.roles.includes(roleItem.role)
            : matchingRoles.has(roleItem.role);
        if (!held) {
          allHeld = false;
          break;
        }
        const rowForScope =
          permission.kind === 'instance' ? current : undefined;
        const scopeMatch = matchScopedMembership(
          subject,
          roleItem.scope,
          roleItem.role,
          rowForScope,
          policy.scopes,
          resource,
          now,
        );
        if (!scopeMatch.ok) {
          denials.push({ role: roleItem.role, reason: scopeMatch.reason });
          allHeld = false;
          break;
        }
        scopeMembership = scopeMatch.membership ?? scopeMembership;
      }
      roleOk = allHeld;
    }
    if (!roleOk) {
      continue;
    }
    const merged: Grant = freezeDeep(
      compact({
        ...grant,
        where: combineWhere(grant.where, granteeMatch.where),
      }),
    );
    const condition = evaluateGrantCondition(
      merged,
      permission,
      current,
      next,
      subject,
      now,
    );
    if (!condition.matched) {
      if (condition.reason === 'closure-error') {
        emitSafe(
          env.listeners.error,
          condition.cause ?? new Error('closure-error'),
          env.listeners,
        );
      }
      denials.push({
        role: displayRole,
        reason: condition.reason ?? 'condition',
        detail: condition.cause,
      });
      continue;
    }
    if (!grantCoversField(grant.fields, options.field, grant.effect)) {
      continue;
    }
    if (grant.effect === 'deny') {
      const decision: Decision = freezeDeep({
        outcome: 'denied',
        denials: [{ role: displayRole, reason: 'deny' }],
        alternatives: env.skipAlternatives
          ? []
          : alternativesFor(policy, permission, subject, env),
      });
      finish(
        policy,
        subject,
        permission,
        current,
        decision,
        options,
        env,
        trusted,
      );
      return decision;
    }
    allows.push(
      scopeMembership === undefined
        ? { grant: merged }
        : { grant: merged, membership: scopeMembership },
    );
  }

  if (allows.length === 0) {
    const reason: DenialReason =
      denials[0]?.reason ??
      (subject.principal === null
        ? 'anonymous'
        : globalNames.unknown.length > 0 && globalNames.roles.length === 0
          ? 'unknown-role'
          : 'no-grant');
    const decision: Decision = freezeDeep({
      outcome: 'denied',
      denials: denials.length > 0 ? denials : [{ role: null, reason }],
      alternatives: env.skipAlternatives
        ? []
        : alternativesFor(policy, permission, subject, env),
    });
    finish(
      policy,
      subject,
      permission,
      current,
      decision,
      options,
      env,
      trusted,
    );
    return decision;
  }

  const delegationMiss = coveredByDelegation(
    permission,
    subject.delegation,
    resourceIdOf(current),
  );
  if (delegationMiss !== undefined) {
    const decision: Decision = freezeDeep({
      outcome: 'denied',
      denials: [{ role: null, reason: delegationMiss }],
      alternatives: env.skipAlternatives
        ? []
        : alternativesFor(policy, permission, subject, env),
    });
    finish(
      policy,
      subject,
      permission,
      current,
      decision,
      options,
      env,
      trusted,
    );
    return decision;
  }

  const quotaDenials: Denial[] = [];
  let matchedAllow: (typeof allows)[number] | undefined;
  for (const candidate of allows) {
    const consume =
      candidate.grant.approval !== 'human' &&
      shouldConsumeQuota(options.source, env.simulated);
    const quota = applyQuota({
      store: env.limits,
      cache: env.limitCache,
      grant: candidate.grant,
      permissionKey: permission.key,
      subjectId: subject.principal?.id ?? '',
      now,
      consume,
    });
    if (quota.ok) {
      matchedAllow = candidate;
      break;
    }
    quotaDenials.push({
      role: candidate.grant.role,
      reason: quota.reason,
    });
  }
  if (matchedAllow === undefined) {
    const decision: Decision = freezeDeep({
      outcome: 'denied',
      denials: quotaDenials.length > 0 ? quotaDenials : denials,
      alternatives: env.skipAlternatives
        ? []
        : alternativesFor(policy, permission, subject, env),
    });
    finish(
      policy,
      subject,
      permission,
      current,
      decision,
      options,
      env,
      trusted,
    );
    return decision;
  }

  const resourceId =
    permission.kind === 'collection'
      ? '*'
      : current !== null && typeof current === 'object'
        ? String(
            (current as Record<string, unknown>)[resource?.id ?? 'id'] ?? '*',
          )
        : '*';
  const token = env.simulated
    ? 'pd1.simulated'
    : decisionToken({
        key: permission.key,
        resourceId,
        principal: subject.principal,
        actor: subject.actor,
        fingerprint: policy.fingerprint,
      });
  const matched = compact<MatchedGrant>({
    role: matchedAllow.grant.role,
    permission: permission.key,
    to: matchedAllow.grant.to,
    where: matchedAllow.grant.where,
    check: matchedAllow.grant.check,
    approval: matchedAllow.grant.approval,
  });
  const decision: Decision =
    matchedAllow.grant.approval === 'human'
      ? freezeDeep({
          outcome: 'approval-required',
          grant: matched,
          reason: 'human',
          token,
        })
      : freezeDeep({
          outcome: 'granted',
          subject,
          matched,
          token,
        });
  finish(
    policy,
    subject,
    permission,
    current,
    decision,
    options,
    env,
    trusted,
    matchedAllow.membership,
  );
  return decision;
}
