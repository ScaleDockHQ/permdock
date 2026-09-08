import type { Condition } from '../conditions/ast.ts';
import type {
  Decision,
  Denial,
  DenialReason,
  MatchedGrant,
} from './decision.ts';
import type {
  AuthEvent,
  DecisionEvent,
  DecisionSink,
  MembershipSource,
  RoleSource,
  SnapshotV2,
  TokenSigner,
} from './interfaces.ts';
import type { Permission } from './permissions.ts';
import type { Grant, Policy } from './policy.ts';

import { evaluateCondition } from '../conditions/evaluate.ts';
import { compact } from './compact.ts';
import { describe } from './describe.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
  approvalMessage,
  deniedMessage,
} from './errors.ts';
import { freezeDeep } from './freeze.ts';
import { getResource, listPermissions } from './permissions.ts';
import { buildSnapshot, parseSnapshot, signSnapshot } from './snapshot.ts';
import {
  type Actor,
  type CustomRole,
  type Delegation,
  type Membership,
  type Principal,
  type Subject,
  anonymousSubject,
  isPrincipal,
  isSubject,
} from './subject.ts';
import {
  matchScopedMembership,
  nowSeconds,
  resolveActiveTenant,
  tenantsOf,
} from './tenancy.ts';
import { decisionToken } from './token.ts';
import { type Boundary, validateBoundary } from './validation.ts';

export type DecideOptions = {
  readonly trusted?: boolean;
  readonly boundary?: Boundary;
  readonly now?: number;
  readonly source?: DecisionEvent['source'];
  readonly adapter?: string;
  readonly onDenied?: (decision: Decision) => never | void;
};

export type RowPair<T> = {
  readonly current: T;
  readonly next: T;
};

export type WhereResult = {
  readonly condition:
    | Condition
    | { readonly op: 'or'; readonly conditions: readonly [] };
  readonly partial: boolean;
};

export type PermDock = {
  readonly can: {
    (
      permission: Permission<string, unknown, 'instance'>,
      data: unknown,
      options?: DecideOptions,
    ): boolean;
    (
      permission: Permission<string, unknown, 'collection'>,
      data?: unknown,
      options?: DecideOptions,
    ): boolean;
  };
  readonly decide: {
    (
      permission: Permission<string, unknown, 'instance'>,
      data: unknown,
      options?: DecideOptions,
    ): Decision;
    (
      permission: Permission<string, unknown, 'collection'>,
      data?: unknown,
      options?: DecideOptions,
    ): Decision;
  };
  readonly assert: {
    (
      permission: Permission<string, unknown, 'instance'>,
      data: unknown,
      options?: DecideOptions,
    ): Extract<Decision, { readonly outcome: 'granted' }>;
    (
      permission: Permission<string, unknown, 'collection'>,
      data?: unknown,
      options?: DecideOptions,
    ): Extract<Decision, { readonly outcome: 'granted' }>;
  };
  readonly filter: <T>(
    permission: Permission<string, T, 'instance'>,
    rows: readonly T[],
    options?: DecideOptions,
  ) => T[];
  readonly where: (permission: Permission) => WhereResult;
  readonly simulate: {
    (checks: readonly (readonly [Permission, unknown?])[]): Decision[];
    (preview: {
      readonly roles?: readonly string[];
      readonly memberships?: readonly Membership[];
      readonly tenant?: string;
    }): PermDock;
  };
  readonly snapshot: (options?: {
    readonly include?: readonly (
      | Permission
      | { readonly [key: string]: unknown }
    )[];
    readonly tenants?: 'all';
    readonly signer?: TokenSigner;
    readonly audience?: string | readonly string[];
  }) => SnapshotV2 | Promise<string>;
  readonly on: (
    event: 'decision' | 'denied' | 'approval' | 'auth' | 'error',
    handler: (payload: unknown) => void,
  ) => () => void;
  readonly tenant: (id: string) => PermDock;
  readonly team: (id: string) => PermDock;
  readonly memberships: () => readonly Membership[];
  readonly tenants: () => readonly string[];
  readonly roles: (options?: { readonly tenant?: string }) => readonly string[];
  readonly assignable: () => readonly string[];
  readonly subject: Subject;
};

export type CreatePermDockOptions = {
  readonly tenant?: string;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly sink?: DecisionSink;
  readonly session?: string;
  readonly expiresAt?: number;
};

type ListenerMap = {
  decision: Set<(event: DecisionEvent) => void>;
  denied: Set<(event: DecisionEvent) => void>;
  approval: Set<(payload: unknown) => void>;
  auth: Set<(event: AuthEvent) => void>;
  error: Set<(error: unknown) => void>;
};

function isRowPair(value: unknown): value is RowPair<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'current' in value &&
    'next' in value
  );
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

function emitSafe(
  listeners: Set<(payload: unknown) => void>,
  payload: unknown,
  errors: ListenerMap,
): void {
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (error) {
      for (const handler of errors.error) {
        try {
          handler(error);
        } catch {
          // ignore
        }
      }
    }
  }
}

function customRolesFor(
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

function expandRoleNames(
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

function emptyListeners(): ListenerMap {
  return {
    decision: new Set(),
    denied: new Set(),
    approval: new Set(),
    auth: new Set(),
    error: new Set(),
  };
}

function coveredByDelegation(
  permission: Permission,
  delegation: Delegation | undefined,
): DenialReason | undefined {
  if (delegation === undefined) {
    return undefined;
  }
  const hasScopes = delegation.scopes !== undefined;
  const hasDetails = delegation.authorizationDetails !== undefined;
  if (!hasScopes && !hasDetails) {
    return undefined;
  }
  if (hasScopes && (delegation.scopes?.length ?? 0) === 0 && !hasDetails) {
    return 'no-delegation';
  }
  const scopeOk = delegation.scopes?.includes(permission.scope) ?? false;
  const detailOk =
    delegation.authorizationDetails?.some((detail) => {
      if (detail.type !== permission.resource) {
        return false;
      }
      if (detail.actions === undefined) {
        return true;
      }
      return detail.actions.includes(permission.action);
    }) ?? false;
  if (scopeOk || detailOk) {
    return undefined;
  }
  return 'not-delegated';
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

type EvalEnv = {
  readonly emit: boolean;
  readonly simulated: boolean;
  readonly skipAlternatives: boolean;
  readonly customRoles: readonly CustomRole[];
  readonly listeners: ListenerMap;
  readonly sink: DecisionSink | undefined;
  readonly team: string | undefined;
};

function evaluate(
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

  if (subject.principal === null) {
    const decision: Decision = freezeDeep({
      outcome: 'denied',
      denials: [{ role: null, reason: 'anonymous' }],
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

  const declared = new Set(policy.roles.map((role) => role.name));
  const globalNames = expandRoleNames(
    subject.principal.roles ?? [],
    declared,
    env.customRoles,
  );
  if (globalNames.unknown.length > 0) {
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

  for (const membership of subject.principal.memberships ?? []) {
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

  for (const role of policy.roles) {
    if (!matchingRoles.has(role.name) && role.grants[0]?.scope === 'global') {
      continue;
    }
    for (const grant of role.grants) {
      if (grant.permission.key !== permission.key) {
        continue;
      }
      const scope = grant.scope;
      if (scope !== 'global' && !matchingRoles.has(role.name)) {
        continue;
      }
      if (scope === 'global' && !globalNames.roles.includes(role.name)) {
        continue;
      }
      const rowForScope = permission.kind === 'instance' ? current : undefined;
      const scopeMatch = matchScopedMembership(
        subject,
        scope,
        role.name,
        rowForScope,
        policy.scopes,
        resource,
        now,
      );
      if (!scopeMatch.ok) {
        denials.push({ role: role.name, reason: scopeMatch.reason });
        continue;
      }
      const condition = evaluateGrantCondition(
        grant,
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
          role: role.name,
          reason: condition.reason ?? 'condition',
          detail: condition.cause,
        });
        continue;
      }
      if (grant.effect === 'deny') {
        const decision: Decision = freezeDeep({
          outcome: 'denied',
          denials: [{ role: role.name, reason: 'deny' }],
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
        scopeMatch.membership === undefined
          ? { grant }
          : { grant, membership: scopeMatch.membership },
      );
    }
  }

  if (allows.length === 0) {
    const reason: DenialReason =
      denials[0]?.reason ??
      (globalNames.unknown.length > 0 && globalNames.roles.length === 0
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

  const matchedAllow = allows[0]!;
  const delegationMiss = coveredByDelegation(permission, subject.delegation);
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
          subject: subject as Subject & { readonly principal: Principal },
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

function finish(
  policy: Policy,
  subject: Subject,
  permission: Permission,
  data: unknown,
  decision: Decision,
  options: DecideOptions,
  env: EvalEnv,
  trusted: boolean,
  membership?: Membership,
  counts?: {
    readonly granted: number;
    readonly denied: number;
    readonly approvalRequired: number;
  },
): void {
  if (!env.emit) {
    return;
  }
  const resource = getResource(policy.permissions, permission.resource);
  const resourceId =
    data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)[resource?.id ?? 'id']
      : undefined;
  const event: DecisionEvent = freezeDeep(
    compact<DecisionEvent>({
      type: 'decision' as const,
      at: new Date().toISOString(),
      outcome: decision.outcome,
      permission: permission.key,
      scope: permission.scope,
      resource: compact<DecisionEvent['resource']>({
        type: permission.resource,
        id: resourceId === undefined ? undefined : String(resourceId),
      }),
      subject: compact<DecisionEvent['subject']>({
        principal:
          subject.principal === null
            ? null
            : compact<NonNullable<DecisionEvent['subject']['principal']>>({
                id: subject.principal.id,
                roles: subject.principal.roles ?? [],
                tenant: subject.principal.tenant,
              }),
        actor:
          subject.actor === undefined
            ? undefined
            : { id: subject.actor.id, kind: subject.actor.kind },
        delegation:
          subject.delegation === undefined
            ? undefined
            : compact<NonNullable<DecisionEvent['subject']['delegation']>>({
                scopes: subject.delegation.scopes,
                authorizationDetails: subject.delegation.authorizationDetails,
              }),
      }),
      tenant: subject.principal?.tenant,
      membership,
      via: membership?.via ?? null,
      matched:
        decision.outcome === 'granted'
          ? {
              role: decision.matched.role,
              permission: decision.matched.permission,
            }
          : undefined,
      denials: decision.outcome === 'denied' ? decision.denials : undefined,
      alternatives:
        decision.outcome === 'denied'
          ? decision.alternatives.map((leaf) => leaf.key)
          : undefined,
      token:
        decision.outcome === 'granted' ||
        decision.outcome === 'approval-required'
          ? decision.token
          : undefined,
      trusted,
      source: options.source ?? 'decide',
      adapter: options.adapter,
      counts,
    }),
  );
  emitSafe(
    env.listeners.decision as unknown as Set<(payload: unknown) => void>,
    event,
    env.listeners,
  );
  if (decision.outcome === 'denied') {
    emitSafe(
      env.listeners.denied as unknown as Set<(payload: unknown) => void>,
      event,
      env.listeners,
    );
  }
  if (decision.outcome === 'approval-required') {
    emitSafe(env.listeners.approval, event, env.listeners);
  }
  if (env.sink !== undefined) {
    try {
      const written = env.sink.write([event]);
      if (isThenable(written)) {
        void written.catch((error: unknown) => {
          emitSafe(env.listeners.error, error, env.listeners);
        });
      }
    } catch (error) {
      emitSafe(env.listeners.error, error, env.listeners);
    }
  }
}

function includePrefixes(
  include:
    | readonly (Permission | { readonly [key: string]: unknown })[]
    | undefined,
): readonly string[] | undefined {
  if (include === undefined) {
    return undefined;
  }
  return include.map((item) => {
    if ('key' in item && typeof item.key === 'string') {
      return item.key;
    }
    const leaves = listPermissions(item as never);
    const first = leaves[0];
    if (first === undefined) {
      return '';
    }
    const parts = first.key.split('.');
    parts.pop();
    return parts.join('.');
  });
}

function heldRoles(subject: Subject, tenant?: string): readonly string[] {
  if (subject.principal === null) {
    return [];
  }
  const names = new Set<string>(subject.principal.roles ?? []);
  for (const membership of subject.principal.memberships ?? []) {
    if (tenant !== undefined && membership.tenant !== tenant) {
      continue;
    }
    for (const role of membership.roles) {
      names.add(role);
    }
  }
  return [...names];
}

function collectSnapshotGrants(
  policy: Policy,
  subject: Subject,
  customRoles: readonly CustomRole[],
): readonly { readonly grant: Grant; readonly membership?: Membership }[] {
  const declared = new Set(policy.roles.map((role) => role.name));
  const global = expandRoleNames(
    subject.principal?.roles ?? [],
    declared,
    customRoles,
  );
  const out: { readonly grant: Grant; readonly membership?: Membership }[] = [];
  for (const role of policy.roles) {
    if (
      role.grants[0]?.scope === 'global' &&
      global.roles.includes(role.name)
    ) {
      for (const grant of role.grants) {
        out.push({ grant });
      }
    }
  }
  for (const membership of subject.principal?.memberships ?? []) {
    const expanded = expandRoleNames(membership.roles, declared, customRoles);
    for (const roleName of expanded.roles) {
      const role = policy.rolesByName.get(roleName);
      if (role === undefined) {
        continue;
      }
      for (const grant of role.grants) {
        if (grant.scope === 'global') {
          continue;
        }
        out.push({ grant, membership });
      }
    }
  }
  return out;
}

function buildInstance(
  policy: Policy,
  subject: Subject,
  envBase: {
    readonly customRoles: readonly CustomRole[];
    readonly sink: DecisionSink | undefined;
    readonly simulated: boolean;
    readonly roleSource: RoleSource | undefined;
    readonly queuedAuth: readonly AuthEvent[];
  },
  team?: string,
): PermDock {
  const listeners = emptyListeners();
  const queuedAuth = [...envBase.queuedAuth];
  const envFor = (emit: boolean): EvalEnv => ({
    emit,
    simulated: envBase.simulated,
    skipAlternatives: false,
    customRoles: envBase.customRoles,
    listeners,
    sink: envBase.sink,
    team,
  });

  const decideImpl = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): Decision =>
    evaluate(
      policy,
      subject,
      permission,
      data,
      options ?? {},
      envFor(options?.source !== 'simulate'),
    );

  const canImpl = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): boolean => {
    try {
      return (
        decideImpl(permission, data, {
          ...options,
          source: options?.source ?? 'can',
        }).outcome === 'granted'
      );
    } catch {
      return false;
    }
  };

  const assertImpl = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): Extract<Decision, { readonly outcome: 'granted' }> => {
    const decision = decideImpl(permission, data, {
      ...options,
      source: options?.source ?? 'assert',
    });
    if (decision.outcome === 'granted') {
      return decision;
    }
    const onDenied = options?.onDenied ?? policy.onDenied;
    if (onDenied !== undefined) {
      onDenied(decision);
    }
    const resource = getResource(policy.permissions, permission.resource);
    const resourceId =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)[resource?.id ?? 'id']
        : undefined;
    const resourceRef = compact<{
      readonly type: string;
      readonly id?: string;
    }>({
      type: permission.resource,
      id: resourceId === undefined ? undefined : String(resourceId),
    });
    if (decision.outcome === 'approval-required') {
      throw new PermDockApprovalRequiredError({
        decision,
        permission: permission.key,
        scope: permission.scope,
        resource: resourceRef,
        message: approvalMessage(
          permission.key,
          decision.reason,
          decision.token,
        ),
      });
    }
    if (decision.denials.some((denial) => denial.reason === 'validation')) {
      const detail = decision.denials[0]?.detail;
      if (detail instanceof PermDockValidationError) {
        throw detail;
      }
    }
    throw new PermDockDeniedError({
      decision,
      permission: permission.key,
      scope: permission.scope,
      resource: resourceRef,
      subject,
      message: deniedMessage(
        permission.key,
        subject.principal?.id,
        decision.denials,
        decision.alternatives.map((leaf) => leaf.key),
      ),
    });
  };

  const instance: PermDock = {
    can: canImpl as PermDock['can'],
    decide: decideImpl as PermDock['decide'],
    assert: assertImpl as PermDock['assert'],
    filter<T>(
      permission: Permission<string, T, 'instance'>,
      rows: readonly T[],
      options?: DecideOptions,
    ): T[] {
      const allowed: T[] = [];
      let granted = 0;
      let denied = 0;
      let approvalRequired = 0;
      const quiet = envFor(false);
      const trusted = options?.trusted ?? true;
      const decideOptions: DecideOptions = {
        ...options,
        source: 'filter',
        trusted,
      };
      for (const row of rows) {
        const decision = evaluate(
          policy,
          subject,
          permission,
          row,
          decideOptions,
          quiet,
        );
        if (decision.outcome === 'granted') {
          allowed.push(row);
          granted += 1;
        } else if (decision.outcome === 'approval-required') {
          approvalRequired += 1;
        } else {
          denied += 1;
        }
      }
      const summary: Decision =
        granted > 0
          ? freezeDeep({
              outcome: 'granted',
              subject: subject as Subject & { readonly principal: Principal },
              matched: {
                role: '*',
                permission: permission.key,
              },
              token: 'pd1.filter',
            })
          : freezeDeep({
              outcome: 'denied',
              denials: [{ role: null, reason: 'no-grant' }],
              alternatives: [],
            });
      finish(
        policy,
        subject,
        permission,
        rows[0],
        summary,
        decideOptions,
        { ...quiet, emit: true },
        trusted,
        undefined,
        { granted, denied, approvalRequired },
      );
      return allowed;
    },
    where(permission: Permission): WhereResult {
      const grants = collectSnapshotGrants(
        policy,
        subject,
        envBase.customRoles,
      ).filter((item) => item.grant.permission.key === permission.key);
      const allows = grants.filter(
        (item) => item.grant.effect === 'allow' && item.grant.portable,
      );
      const denies = grants.filter(
        (item) => item.grant.effect === 'deny' && item.grant.portable,
      );
      const partial = grants.some((item) => !item.grant.portable);
      if (allows.length === 0) {
        return {
          condition: { op: 'or', conditions: [] },
          partial,
        };
      }
      const parts: Condition[] = allows.map((item) => {
        let condition: Condition = item.grant.where ?? {
          op: 'eq',
          field: '_',
          value: true,
        };
        for (const denyGrant of denies) {
          if (denyGrant.grant.where !== undefined) {
            condition = {
              op: 'and',
              conditions: [
                condition,
                { op: 'not', condition: denyGrant.grant.where },
              ],
            };
          }
        }
        return condition;
      });
      return {
        condition:
          parts.length === 1 ? parts[0]! : { op: 'or', conditions: parts },
        partial,
      };
    },
    simulate: ((
      input:
        | readonly (readonly [Permission, unknown?])[]
        | {
            readonly roles?: readonly string[];
            readonly memberships?: readonly Membership[];
            readonly tenant?: string;
          },
    ): Decision[] | PermDock => {
      if (Array.isArray(input)) {
        return input.map(([permission, data]) =>
          evaluate(
            policy,
            subject,
            permission,
            data,
            { source: 'simulate', trusted: true },
            envFor(false),
          ),
        );
      }
      const preview = input as {
        readonly roles?: readonly string[];
        readonly memberships?: readonly Membership[];
        readonly tenant?: string;
      };
      const previewPrincipal =
        subject.principal === null
          ? null
          : freezeDeep(
              compact<Principal>({
                ...subject.principal,
                roles: preview.roles ?? subject.principal.roles,
                memberships:
                  preview.memberships ?? subject.principal.memberships,
                tenant: preview.tenant ?? subject.principal.tenant,
              }),
            );
      const previewSubject: Subject = freezeDeep({
        ...subject,
        principal: previewPrincipal,
      });
      return buildInstance(
        policy,
        previewSubject,
        { ...envBase, simulated: true },
        team,
      );
    }) as PermDock['simulate'],
    snapshot(options) {
      const snapshot = buildSnapshot(
        compact<Parameters<typeof buildSnapshot>[0]>({
          subject,
          roles: heldRoles(subject, subject.principal?.tenant),
          grants: collectSnapshotGrants(policy, subject, envBase.customRoles),
          include: includePrefixes(options?.include),
          tenants: options?.tenants,
          simulated: envBase.simulated,
        }),
      );
      if (options?.signer !== undefined) {
        return signSnapshot(snapshot, options.signer, options.audience);
      }
      return snapshot;
    },
    on(event, handler) {
      const set = listeners[event] as Set<(payload: unknown) => void>;
      set.add(handler);
      if (event === 'auth') {
        for (const queued of queuedAuth) {
          try {
            (handler as (payload: AuthEvent) => void)(queued);
          } catch (error) {
            emitSafe(listeners.error, error, listeners);
          }
        }
      }
      return (): void => {
        set.delete(handler);
      };
    },
    tenant(id: string): PermDock {
      if (subject.principal === null) {
        return buildInstance(policy, subject, envBase, team);
      }
      const next = freezeDeep(
        compact<Subject>({
          ...subject,
          principal: compact<Principal>({
            ...subject.principal,
            tenant: resolveActiveTenant(subject.principal, id),
          }),
        }),
      );
      return buildInstance(policy, next, envBase, team);
    },
    team(id: string): PermDock {
      return buildInstance(policy, subject, envBase, id);
    },
    memberships(): readonly Membership[] {
      return subject.principal?.memberships ?? [];
    },
    tenants(): readonly string[] {
      return tenantsOf(subject.principal);
    },
    roles(options?: { readonly tenant?: string }): readonly string[] {
      return heldRoles(subject, options?.tenant ?? subject.principal?.tenant);
    },
    assignable(): readonly string[] {
      const tenant = subject.principal?.tenant;
      const held = new Set(heldRoles(subject, tenant));
      const declared = policy.roles
        .filter((role) => role.assignable)
        .map((role) => role.name);
      const allowed = declared.filter((name) => held.has(name));
      return allowed;
    },
    subject,
  };
  return Object.freeze(instance);
}

function assemblePrincipal(
  policy: Policy,
  user: unknown,
  options: CreatePermDockOptions,
  auth: AuthEvent[],
): {
  readonly principal: Principal | null;
  readonly context:
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  readonly actor: Actor | undefined;
  readonly delegation: Delegation | undefined;
  readonly session: string | undefined;
  readonly expiresAt: number | undefined;
  readonly memberships: readonly Membership[] | Promise<readonly Membership[]>;
} {
  let principal: Principal | null;
  let context: Readonly<Record<string, unknown>> = {};
  let actor = options.actor;
  let delegation = options.delegation;
  let session = options.session;
  let expiresAt = options.expiresAt;
  try {
    if (user === null || user === undefined) {
      principal = policy.subject(user as never);
    } else if (isSubject(user)) {
      principal = user.principal;
      context = user.context;
      actor = user.actor ?? actor;
      delegation = user.delegation ?? delegation;
      session = user.session ?? session;
      expiresAt = user.expiresAt ?? expiresAt;
    } else if (isPrincipal(user)) {
      principal = user;
    } else {
      principal = policy.subject(user as never);
    }
  } catch {
    principal = null;
  }
  const contextResult =
    policy.context === undefined ? context : policy.context(user as never);
  let memberships: readonly Membership[] | Promise<readonly Membership[]> =
    principal?.memberships ?? [];
  if (principal !== null && options.memberships !== undefined) {
    try {
      memberships = options.memberships.membershipsFor(
        compact({ id: principal.id, kind: principal.kind }),
        compact({ tenant: options.tenant }),
      );
    } catch {
      auth.push({ reason: 'source-threw', source: 'memberships' });
      memberships = [];
    }
  }
  return {
    principal,
    context: contextResult,
    actor,
    delegation,
    session,
    expiresAt,
    memberships,
  };
}

function finishSubject(
  assembled: ReturnType<typeof assemblePrincipal>,
  context: Readonly<Record<string, unknown>>,
  memberships: readonly Membership[],
  options: CreatePermDockOptions,
): Subject {
  if (assembled.principal === null) {
    return freezeDeep(
      compact<Subject>({
        ...anonymousSubject(context),
        actor: assembled.actor,
        delegation: assembled.delegation,
        session: assembled.session,
        expiresAt: assembled.expiresAt,
      }),
    );
  }
  const withMemberships: Principal = freezeDeep(
    compact<Principal>({
      ...assembled.principal,
      memberships,
      tenant: resolveActiveTenant(
        { ...assembled.principal, memberships },
        options.tenant ?? assembled.principal.tenant,
      ),
    }),
  );
  return freezeDeep(
    compact<Subject>({
      principal: withMemberships,
      actor: assembled.actor,
      delegation: assembled.delegation,
      context: freezeDeep({ ...context }),
      session: assembled.session,
      expiresAt: assembled.expiresAt,
    }),
  );
}

function resolveSubject(
  policy: Policy,
  user: unknown,
  options: CreatePermDockOptions,
  auth: AuthEvent[],
): Subject | Promise<Subject> {
  const assembled = assemblePrincipal(policy, user, options, auth);
  if (isThenable(assembled.context) || isThenable(assembled.memberships)) {
    return Promise.all([
      Promise.resolve(assembled.context),
      Promise.resolve(assembled.memberships).catch(() => {
        auth.push({ reason: 'source-threw', source: 'memberships' });
        return [] as Membership[];
      }),
    ]).then(([context, memberships]) =>
      finishSubject(assembled, context, memberships, options),
    );
  }
  return finishSubject(
    assembled,
    assembled.context,
    assembled.memberships,
    options,
  );
}

function instantiate(
  policy: Policy,
  subject: Subject,
  options: CreatePermDockOptions,
  auth: AuthEvent[],
): PermDock | Promise<PermDock> {
  const tenants = tenantsOf(subject.principal);
  const customRoles = customRolesFor(options.customRoles, tenants, auth);
  const build = (roles: readonly CustomRole[]): PermDock =>
    buildInstance(policy, subject, {
      customRoles: roles,
      sink: options.sink,
      simulated: false,
      roleSource: options.customRoles,
      queuedAuth: auth,
    });
  if (isThenable(customRoles)) {
    return customRoles.then(build);
  }
  return build(customRoles);
}

export function createPermDock(
  policy: Policy,
  user: unknown,
  options: CreatePermDockOptions = {},
): PermDock | Promise<PermDock> {
  const auth: AuthEvent[] = [];
  const subject = resolveSubject(policy, user, options, auth);
  if (isThenable(subject)) {
    return subject.then((resolved) =>
      instantiate(policy, resolved, options, auth),
    );
  }
  return instantiate(policy, subject, options, auth);
}

export { describe, parseSnapshot };
