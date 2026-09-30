import type { RelatedCondition } from '../conditions/ast.ts';
import type {
  Decision,
  Denial,
  DenialReason,
  GrantedDecision,
  MatchedGrant,
  Obligation,
} from './decision.ts';
import type { AuthEvent, DecisionEvent, RoleSource } from './interfaces.ts';
import type { DecideOptions, RowPair } from './permdock.ts';
import type { Permission } from './permissions.ts';
import type { RelationReader } from './relations.ts';
import type { CustomRole, Membership, Subject } from './subject.ts';

import { evaluateCondition } from '../conditions/evaluate.ts';
import { compact } from './compact.ts';
import { isCustomRoleName, holdsCustomRole } from './custom-roles.ts';
import { coveredByDelegation, resourceIdOf } from './delegation.ts';
import {
  actorRequiredVias,
  evaluateBreakGlass,
  isSupportMembership,
  purposesOf,
} from './elevated.ts';
import { PermDockValidationError } from './errors.ts';
import { type EvalEnv, emitSafe, finish } from './events.ts';
import { grantCoversField } from './fields.ts';
import { freezeDeep } from './freeze.ts';
import {
  combineWhere,
  flattenGrantee,
  matchGrantee,
  resourceRoleCondition,
} from './grantee.ts';
import { applyQuota } from './limits.ts';
import { getResource, listPermissions } from './permissions.ts';
import {
  grantList,
  requiresApproval,
  type Grant,
  type Policy,
} from './policy.ts';
import { resolveRelated } from './relations.ts';
import { scopeList, tenantOf } from './scopes.ts';
import {
  inTeam,
  isMembershipExpired,
  matchScopedMembership,
  nowSeconds,
  type ResourceRoleWalk,
} from './tenancy.ts';
import { isThenable } from './thenable.ts';
import { decisionToken, versionOf } from './token.ts';
import { validateBoundary } from './validation.ts';
import { listRoles } from './vocabulary.ts';

type ScopeMatch = ReturnType<typeof matchScopedMembership>;

/**
 * A collection write proposes `next`; an update pair may move `next` out of
 * the scope `current` is in. Both must stay in scope.
 */
function matchWriteScope(
  match: (row: unknown) => ScopeMatch,
  instance: boolean,
  current: unknown,
  next: unknown,
): ScopeMatch {
  const first = match(instance ? current : next);
  if (!first.ok || !instance || next === current) {
    return first;
  }
  const moved = match(next);
  return moved.ok ? first : moved;
}

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
        Promise.resolve(item).catch((): CustomRole[] => {
          auth.push({ reason: 'source-threw', source: 'customRoles' });
          return [];
        }),
      ),
    ).then((lists) => lists.flat());
  }
  // SAFETY: the branch above returns when any item is a thenable, so every item is a list.
  return (loaded as CustomRole[][]).flat();
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * `RoleSource.assignable` per tenant; `undefined` when the source has no
 * `assignable`. A tenant whose call throws or answers junk assigns nothing.
 */
export function assignableNamesFor(
  source: RoleSource | undefined,
  tenants: readonly string[],
  auth: AuthEvent[],
):
  | ReadonlyMap<string, readonly string[]>
  | Promise<ReadonlyMap<string, readonly string[]>>
  | undefined {
  if (source?.assignable === undefined) {
    return undefined;
  }
  const failed = (): string[] => {
    auth.push({ reason: 'source-threw', source: 'customRoles' });
    return [];
  };
  const loaded = tenants.map((tenant) => {
    try {
      return source.assignable?.(tenant) ?? [];
    } catch {
      return failed();
    }
  });
  const toMap = (lists: readonly unknown[]): Map<string, readonly string[]> =>
    new Map(tenants.map((tenant, index) => [tenant, stringList(lists[index])]));
  if (loaded.some((item) => isThenable(item))) {
    return Promise.all(
      loaded.map((item) => Promise.resolve(item).catch(failed)),
    ).then(toMap);
  }
  return toMap(loaded);
}

/**
 * The declared role names among `names`. A custom role of `tenant` is known
 * but contributes no declared name: its grants are resolved separately
 * (`customGrantsFor`), bounded by the ceiling. A tenant's custom role is
 * unknown inside another tenant and for a membership without one.
 */
export function expandRoleNames(
  names: readonly string[],
  declared: ReadonlySet<string>,
  custom: readonly CustomRole[],
  tenant: string | undefined,
): { readonly roles: readonly string[]; readonly unknown: readonly string[] } {
  const resolved = new Set<string>();
  const unknown: string[] = [];
  for (const name of names) {
    if (declared.has(name)) {
      resolved.add(name);
    } else if (!isCustomRoleName(name, custom, tenant)) {
      unknown.push(name);
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

function alternativesFor(
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
      { trusted: true, source: 'decide', now },
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
  scopes: Policy['scopes'],
  relations: RelationReader | undefined,
): {
  readonly matched: boolean;
  readonly reason?: DenialReason;
  readonly cause?: unknown;
} {
  // Any graph read the instance could not answer fails the grant, whatever the
  // rest of the condition says, so `not` and `or` cannot turn it into a match.
  let unknown: 'relation-depth' | 'relation-unavailable' | undefined;
  const related = (condition: RelatedCondition, row: unknown): boolean => {
    if (relations === undefined) {
      unknown ??= 'relation-unavailable';
      return false;
    }
    const verdict = resolveRelated(condition, row, subject, now, relations);
    if (verdict === 'relation-depth' || verdict === 'relation-unavailable') {
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
    const matched = evaluateCondition(
      grant.where,
      current,
      subject,
      now,
      scopes,
      related,
    );
    if (unknown !== undefined) {
      return { matched: false, reason: unknown };
    }
    if (!matched) {
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
    const matched = evaluateCondition(
      checkCondition,
      next,
      subject,
      now,
      scopes,
      related,
    );
    if (unknown !== undefined) {
      return { matched: false, reason: unknown };
    }
    if (!matched) {
      return { matched: false, reason: 'condition' };
    }
  }
  return { matched: true };
}

function isGraphUnknown(reason: DenialReason | undefined): boolean {
  return reason === 'relation-depth' || reason === 'relation-unavailable';
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

  const scopes = scopeList(policy.scopes);
  const declared = declaredRoleNames(policy);
  const principalRoles = subject.principal?.roles ?? [];
  const globalNames = expandRoleNames(
    principalRoles,
    declared,
    env.customRoles,
    subject.principal?.tenant,
  );
  if (subject.principal !== null && globalNames.unknown.length > 0) {
    // SAFETY: emitSafe passes these listeners only the AuthEvent literal below.
    emitSafe(
      env.listeners.auth as unknown as Set<(payload: unknown) => void>,
      { reason: 'unknown-role', source: 'roles' } satisfies AuthEvent,
      env.listeners,
    );
  }

  const denials: Denial[] = [];
  const allows: {
    readonly grant: Grant;
    readonly membership?: Membership;
    readonly obligations?: readonly Obligation[];
    readonly breakGlass?: true;
  }[] = [];
  const matchingRoles = new Set<string>(globalNames.roles);

  for (const membership of subject.principal?.memberships ?? []) {
    if (!inTeam(membership, scopes, env.team)) {
      continue;
    }
    const expanded = expandRoleNames(
      membership.roles,
      declared,
      env.customRoles,
      tenantOf(membership, scopes),
    );
    for (const name of expanded.roles) {
      matchingRoles.add(name);
    }
    for (const name of expanded.unknown) {
      denials.push({ role: name, reason: 'unknown-role' });
    }
  }

  const supports = policy.roles.flatMap((binding) =>
    binding.support === undefined ? [] : [binding.support],
  );
  const actorVias = actorRequiredVias(supports);
  if (
    actorVias.size > 0 &&
    subject.actor === undefined &&
    (subject.principal?.memberships ?? []).some(
      (membership) =>
        isSupportMembership(membership, actorVias) &&
        !isMembershipExpired(membership, now) &&
        inTeam(membership, scopes, env.team),
    )
  ) {
    const decision: Decision = freezeDeep({
      outcome: 'denied',
      denials: [{ role: null, reason: 'actor-required' }],
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

  const purposes = purposesOf(subject);

  const candidates: { readonly grant: Grant; readonly custom?: CustomRole }[] =
    grantList(policy)
      .filter(
        (grant) =>
          grant.permission.key === permission.key &&
          grant.breakGlass === undefined,
      )
      .map((grant) => ({ grant }));
  for (const item of env.customGrants) {
    if (item.grant.permission.key === permission.key) {
      candidates.push({ grant: item.grant, custom: item.role });
    }
  }

  let breakGlassGrant: Grant | undefined;
  let breakGlassObligations: readonly Obligation[] = [];
  const breakGlassOverrides = new Set<string>();
  let breakGlassDenial: Denial | undefined;
  for (const grant of grantList(policy)) {
    if (
      grant.permission.key !== permission.key ||
      grant.breakGlass === undefined
    ) {
      continue;
    }
    if (!matchGrantee(grant.to, subject, now, resource, scopes).matched) {
      continue;
    }
    const result = evaluateBreakGlass(grant.breakGlass, subject, now);
    if (result.kind === 'inactive') {
      continue;
    }
    for (const name of grant.breakGlass.overrides) {
      breakGlassOverrides.add(name);
    }
    if (result.kind === 'granted') {
      breakGlassGrant = grant;
      breakGlassObligations = result.obligations;
      break;
    }
    breakGlassDenial ??=
      result.reason === 'insufficient-user-authentication'
        ? { role: null, reason: result.reason, to: result.to }
        : { role: null, reason: result.reason };
  }

  const holdsCustom = (custom: CustomRole): boolean =>
    (subject.principal?.memberships ?? []).some(
      (membership) =>
        inTeam(membership, scopes, env.team) &&
        holdsCustomRole(membership, custom, scopes),
    );

  const walkRole: ResourceRoleWalk | undefined =
    env.relations?.available === true
      ? (membership, row) => {
          const on = membership.on;
          const condition =
            on === undefined
              ? undefined
              : resourceRoleCondition(
                  resource,
                  on.resource,
                  [on.id],
                  policy.resources,
                );
          return condition === undefined || env.relations === undefined
            ? false
            : resolveRelated(condition, row, subject, now, env.relations);
        }
      : undefined;

  for (const { grant, custom } of candidates) {
    const displayRole = grant.role;
    if (
      grant.viaOnly !== undefined &&
      !(subject.principal?.memberships ?? []).some(
        (membership) =>
          membership.via === grant.viaOnly &&
          !isMembershipExpired(membership, now) &&
          inTeam(membership, scopes, env.team),
      )
    ) {
      continue;
    }
    const required = grant.purpose;
    if (
      required !== undefined &&
      !purposes.some((purpose) => required.includes(purpose))
    ) {
      continue;
    }
    const granteeMatch = matchGrantee(
      grant.to,
      subject,
      now,
      resource,
      scopes,
      policy.resources,
    );
    if (!granteeMatch.matched) {
      const reason = granteeMatch.reason ?? 'no-grant';
      if (
        reason === 'not-entitled' &&
        !flattenGrantee(grant.to).every(
          (item) =>
            item.kind !== 'role' ||
            (custom === undefined
              ? item.scope === 'global'
                ? globalNames.roles.includes(item.role)
                : matchingRoles.has(item.role)
              : holdsCustom(custom)),
        )
      ) {
        continue;
      }
      denials.push(
        (reason === 'insufficient-user-authentication' ||
          reason === 'not-entitled') &&
          grant.to !== undefined
          ? { role: displayRole, reason, to: grant.to }
          : { role: displayRole, reason },
      );
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
          custom === undefined
            ? roleItem.scope === 'global'
              ? globalNames.roles.includes(roleItem.role)
              : matchingRoles.has(roleItem.role)
            : holdsCustom(custom);
        if (!held) {
          allHeld = false;
          break;
        }
        const matchRow = (row: unknown): ScopeMatch =>
          matchScopedMembership(
            subject,
            roleItem.scope,
            roleItem.role,
            row,
            scopes,
            resource,
            policy.resources,
            now,
            (membership) => {
              if (custom === undefined) {
                return expandRoleNames(
                  membership.roles,
                  declared,
                  env.customRoles,
                  tenantOf(membership, scopes),
                ).roles;
              }
              return holdsCustomRole(membership, custom, scopes)
                ? [custom.name]
                : [];
            },
            env.team,
            walkRole,
          );
        const scopeMatch = matchWriteScope(
          matchRow,
          permission.kind === 'instance',
          current,
          next,
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
      scopes,
      env.relations,
    );
    if (
      !condition.matched &&
      grant.effect === 'deny' &&
      isGraphUnknown(condition.reason)
    ) {
      const decision: Decision = freezeDeep({
        outcome: 'denied',
        denials: [
          {
            role: displayRole,
            reason: condition.reason ?? 'relation-unavailable',
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
      if (grant.name !== undefined && breakGlassOverrides.has(grant.name)) {
        if (breakGlassGrant !== undefined) {
          continue;
        }
        if (breakGlassDenial !== undefined) {
          const decision: Decision = freezeDeep({
            outcome: 'denied',
            denials: [breakGlassDenial],
            alternatives: env.skipAlternatives
              ? []
              : alternativesFor(policy, permission, subject, now, env),
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
      }
      const decision: Decision = freezeDeep({
        outcome: 'denied',
        denials: [{ role: displayRole, reason: 'deny' }],
        alternatives: env.skipAlternatives
          ? []
          : alternativesFor(policy, permission, subject, now, env),
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

  if (breakGlassGrant !== undefined) {
    allows.push({
      grant: breakGlassGrant,
      obligations: breakGlassObligations,
      breakGlass: true,
    });
  } else if (breakGlassDenial !== undefined) {
    denials.unshift(breakGlassDenial);
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
        : alternativesFor(policy, permission, subject, now, env),
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

  if (subject.stale === true && (policy.fresh ?? []).includes(permission.key)) {
    const decision: Decision = freezeDeep({
      outcome: 'denied',
      denials: [{ role: null, reason: 'stale-credentials' }],
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

  const delegationMiss = coveredByDelegation(
    permission,
    subject.delegation,
    resourceIdOf(current),
    subject.actor !== undefined,
  );
  if (delegationMiss !== undefined) {
    const decision: Decision = freezeDeep({
      outcome: 'denied',
      denials: [{ role: null, reason: delegationMiss }],
      alternatives: env.skipAlternatives
        ? []
        : alternativesFor(policy, permission, subject, now, env),
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
  let quotaState: Pick<GrantedDecision, 'quota' | 'obligations'> = {};
  for (const candidate of allows) {
    const consume =
      !requiresApproval(candidate.grant.approval) &&
      shouldConsumeQuota(options.source, env.simulated);
    const quota = applyQuota({
      store: env.limits,
      cache: env.limitCache,
      grant: candidate.grant,
      permissionKey: permission.key,
      subjectId: subject.principal?.id ?? '',
      tenant: subject.principal?.tenant,
      now,
      consume,
    });
    if (quota.ok) {
      matchedAllow = candidate;
      quotaState = compact({
        quota: quota.quota,
        obligations: quota.obligations,
      });
      break;
    }
    quotaDenials.push(
      quota.reason === 'limit'
        ? { role: candidate.grant.role, reason: 'limit', detail: quota.detail }
        : { role: candidate.grant.role, reason: quota.reason },
    );
  }
  if (matchedAllow === undefined) {
    const decision: Decision = freezeDeep({
      outcome: 'denied',
      denials: quotaDenials.length > 0 ? quotaDenials : denials,
      alternatives: env.skipAlternatives
        ? []
        : alternativesFor(policy, permission, subject, now, env),
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

  // SAFETY: current is a non-null object checked in the condition; the read value stays unknown.
  const resourceId =
    permission.kind === 'collection'
      ? '*'
      : current !== null && typeof current === 'object'
        ? String(
            (current as Record<string, unknown>)[resource?.id ?? 'id'] ?? '*',
          )
        : '*';
  const approval = matchedAllow.grant.approval;
  const version =
    approval !== undefined &&
    approval !== 'human' &&
    approval.staleOn === 'resource-change' &&
    resource?.version !== undefined
      ? versionOf(current, resource.version)
      : undefined;
  const token = env.simulated
    ? 'pd1.simulated'
    : decisionToken({
        key: permission.key,
        resourceId,
        principal: subject.principal,
        actor: subject.actor,
        fingerprint: policy.fingerprint,
        version,
      });
  const matched = compact<MatchedGrant>({
    role: matchedAllow.grant.role,
    permission: permission.key,
    to: matchedAllow.grant.to,
    where: matchedAllow.grant.where,
    check: matchedAllow.grant.check,
    approval: matchedAllow.grant.approval,
    hosted: matchedAllow.grant.hosted,
    breakGlass: matchedAllow.breakGlass,
  });
  const obligations = [
    ...(quotaState.obligations ?? []),
    ...(matchedAllow.obligations ?? []),
  ];
  const decision: Decision = requiresApproval(matchedAllow.grant.approval)
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
        ...quotaState,
        ...(obligations.length === 0 ? {} : { obligations }),
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
