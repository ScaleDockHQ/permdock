import type { Condition } from '../conditions/ast.ts';
import type { Decision, ExplainedDecision } from '../core/decision.ts';
import type { DecisionProvider } from '../core/interfaces.ts';
import type {
  PermDockOptions,
  DecideOptions,
  PermDock,
  SimulateOptions,
  WhereResult,
} from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy, PolicyVocabulary } from '../core/policy.ts';
import type { Membership, Principal, Subject } from '../core/subject.ts';
import type { PdpPermDock } from './types.ts';

import { isArazzoSimulateInput } from '../core/arazzo.ts';
import { compact, isReadonlyArray } from '../core/compact.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
  approvalMessage,
  deniedMessage,
} from '../core/errors.ts';
import { freezeDeep } from '../core/freeze.ts';
import { createPermDock as createCore } from '../core/permdock.ts';
import { getResource } from '../core/permissions.ts';
import { denied, resourceIdOf } from './shared.ts';

function withoutProviders<
  TUser,
  TPrincipal extends Principal,
  V extends PolicyVocabulary,
>(policy: Policy<TUser, TPrincipal, V>): Policy<TUser, TPrincipal, V> {
  if (policy.providers === undefined || policy.providers.length === 0) {
    return policy;
  }
  return freezeDeep(
    compact<Policy<TUser, TPrincipal, V>>({
      permissions: policy.permissions,
      roles: policy.roles,
      rolesByName: policy.rolesByName,
      grants: policy.grants,
      vocabulary: policy.vocabulary,
      scopes: policy.scopes,
      principal(user: TUser) {
        return policy.principal(user);
      },
      subject(user: TUser) {
        return policy.subject(user);
      },
      context(user: TUser) {
        return policy.context?.(user);
      },
      validate: policy.validate,
      onDenied: policy.onDenied,
      fingerprint: policy.fingerprint,
      resources: policy.resources,
      index: policy.index,
    }),
  );
}

function providerFor(
  providers: readonly DecisionProvider[],
  permission: Permission,
): DecisionProvider | undefined {
  for (const provider of providers) {
    if (provider.handles(permission)) {
      return provider;
    }
  }
  return undefined;
}

function idFieldOf(policy: Policy, permission: Permission): string {
  return getResource(policy.permissions, permission.resource)?.id ?? 'id';
}

function isExplicitDeny(decision: Decision): boolean {
  return (
    decision.outcome === 'denied' &&
    decision.denials.some((denial) => denial.reason === 'deny')
  );
}

function isLocalShortCircuit(decision: Decision): boolean {
  if (decision.outcome !== 'denied') {
    return false;
  }
  if (isExplicitDeny(decision)) {
    return true;
  }
  return decision.denials.some((denial) => {
    switch (denial.reason) {
      case 'no-grant':
      case 'inactive-grant':
        return false;
      case 'pdp-denied':
      case 'pdp-unavailable':
      case 'pdp-invalid-response':
        return false;
      case 'anonymous':
      case 'validation':
      case 'not-delegated':
      case 'no-delegation':
      case 'condition':
      case 'deny':
      case 'closure-error':
      case 'opaque-condition':
      case 'server-only':
      case 'insufficient-user-authentication':
      case 'not-entitled':
      case 'purpose':
      case 'reason-required':
      case 'actor-required':
      case 'limit':
      case 'limit-unavailable':
      case 'relation-depth':
      case 'relation-unavailable':
      case 'tenant-mismatch':
      case 'no-membership':
      case 'scope':
      case 'expired-membership':
      case 'stale-credentials':
      case 'unknown-role':
      case 'last-holder':
      case 'max-holders':
      case 'transfer-only':
      case 'not-assignable-by':
      case 'self-demotion':
      case 'externally-managed':
      case 'not-allowed-for-membership':
      case 'conflicting-role':
      case 'approval':
      case 'stale-approval':
      case 'undocumented':
      case 'unsupported':
      case 'exceeds-creator':
      case 'credential-policy':
        return true;
      default: {
        const exhaustive: never = denial.reason;
        return exhaustive;
      }
    }
  });
}

function wrap<V extends PolicyVocabulary>(
  permdock: PermDock<V>,
  policy: Policy,
  subject: Subject,
  providers: readonly DecisionProvider[],
): PdpPermDock<V> {
  // SAFETY: decide's generics only tie the row type to the permission; it accepts any row.
  const decideLocal = permdock.decide as (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ) => Decision;

  const decide = async (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): Promise<Decision> => {
    const local = decideLocal(permission, data, options);
    const provider = providerFor(providers, permission);
    if (provider === undefined || isLocalShortCircuit(local)) {
      return local;
    }
    try {
      return await provider.decide({
        permission,
        data,
        subject,
        local,
      });
    } catch {
      return denied('pdp-unavailable');
    }
  };

  /** The local trace; a remote decision evaluated no local grant, so its trace is empty. */
  const explain = async (
    permission: Permission,
    data?: unknown,
    options?: Omit<DecideOptions, 'explain'>,
  ): Promise<ExplainedDecision> => {
    const decision = await decide(permission, data, {
      ...options,
      source: options?.source ?? 'explain',
      explain: true,
    });
    if (decision.trace !== undefined) {
      // SAFETY: the trace is present, so the decision is an ExplainedDecision.
      return decision as ExplainedDecision;
    }
    return freezeDeep({
      ...decision,
      trace: { evaluated: 0, allows: [], denies: [], skipped: [] },
    });
  };

  const permittedIds = async (
    provider: DecisionProvider | undefined,
    permission: Permission,
  ): Promise<readonly string[] | null | undefined> => {
    if (provider?.permitted === undefined || subject.principal === null) {
      return undefined;
    }
    try {
      return await provider.permitted({ permission, subject });
    } catch {
      return null;
    }
  };

  const can = async (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): Promise<boolean> => {
    try {
      return (await decide(permission, data, options)).outcome === 'granted';
    } catch {
      return false;
    }
  };

  const assert = async (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): Promise<Extract<Decision, { readonly outcome: 'granted' }>> => {
    const decision = await decide(permission, data, {
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
    // SAFETY: data was checked to be a non-null object; the id stays unknown until String().
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

  // SAFETY: the branches handle each of simulate's overloads and return its matching result.
  const simulate = ((
    input:
      | readonly (readonly [Permission, unknown?])[]
      | Parameters<PermDock['simulate']>[0],
    options?: SimulateOptions,
  ) => {
    if (isReadonlyArray(input)) {
      return Promise.all(
        input.map(([permission, data]) =>
          decide(
            permission,
            data,
            compact<DecideOptions>({ source: 'simulate', now: options?.now }),
          ),
        ),
      );
    }
    if (isArazzoSimulateInput(input)) {
      return permdock.simulate(input);
    }
    // SAFETY: pairs and Arazzo inputs returned above; what remains is the role override input.
    return wrap(
      permdock.simulate(
        input as {
          readonly roles?: readonly string[];
          readonly memberships?: readonly Membership[];
          readonly tenant?: string;
        },
      ),
      policy,
      subject,
      providers,
    );
  }) as PdpPermDock<V>['simulate'];

  return {
    can,
    decide,
    assert,
    explain,
    async filter<T>(
      permission: Permission<string, T, 'instance'>,
      rows: readonly T[],
      options?: DecideOptions,
    ): Promise<T[]> {
      const next = { ...options, source: 'filter' as const };
      const provider = providerFor(providers, permission);
      const ids = await permittedIds(provider, permission);
      if (ids === undefined) {
        const decisions = await Promise.all(
          rows.map((row) => decide(permission, row, next)),
        );
        return rows.filter(
          (_, index) => decisions[index]?.outcome === 'granted',
        );
      }
      const allowed = new Set(ids ?? []);
      const field = idFieldOf(policy, permission);
      return rows.filter((row) => {
        const id = resourceIdOf(row, field);
        return (
          allowed.has(id) &&
          !isLocalShortCircuit(decideLocal(permission, row, next))
        );
      });
    },
    pick: permdock.pick.bind(permdock),
    async where(permission: Permission): Promise<WhereResult> {
      const provider = providerFor(providers, permission);
      if (provider === undefined) {
        return permdock.where(permission);
      }
      const ids = await permittedIds(provider, permission);
      if (ids === undefined) {
        return { condition: { op: 'or', conditions: [] }, partial: true };
      }
      if (ids === null || ids.length === 0) {
        return { condition: { op: 'or', conditions: [] }, partial: false };
      }
      const remote: Condition = {
        op: 'in',
        field: idFieldOf(policy, permission),
        value: [...ids],
      };
      const local = permdock.where(permission);
      const hasLocal =
        local.condition.op !== 'or' || local.condition.conditions.length > 0;
      return hasLocal
        ? {
            condition: { op: 'and', conditions: [local.condition, remote] },
            partial: local.partial,
          }
        : { condition: remote, partial: true };
    },
    actions: permdock.actions.bind(permdock),
    simulate,
    snapshot: permdock.snapshot.bind(permdock),
    on: permdock.on.bind(permdock),
    tenant: (id: string): PdpPermDock<V> => {
      const next = permdock.tenant(id);
      return wrap(next, policy, next.subject, providers);
    },
    team: (id: string): PdpPermDock<V> => {
      const next = permdock.team(id);
      return wrap(next, policy, next.subject, providers);
    },
    memberships: permdock.memberships.bind(permdock),
    tenants: permdock.tenants.bind(permdock),
    heldRoles: permdock.heldRoles.bind(permdock),
    audiences: permdock.audiences.bind(permdock),
    assignableRoles: permdock.assignableRoles.bind(permdock),
    assignablePermissions: permdock.assignablePermissions.bind(permdock),
    decideRoleChange: permdock.decideRoleChange.bind(permdock),
    loadRelations: permdock.loadRelations.bind(permdock),
    whoCan: permdock.whoCan.bind(permdock),
    activate: permdock.activate.bind(permdock),
    permissions: permdock.permissions,
    roles: permdock.roles,
    plans: permdock.plans,
    subject,
  };
}

export async function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  user: TUser | null,
  options: PermDockOptions = {},
): Promise<PdpPermDock<V>> {
  const localPolicy = withoutProviders(policy);
  const permdock = await createCore(localPolicy, user, options);
  return wrap(permdock, localPolicy, permdock.subject, policy.providers ?? []);
}
