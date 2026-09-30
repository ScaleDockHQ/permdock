import type { Condition } from '../conditions/ast.ts';
import type { Decision } from '../core/decision.ts';
import type { DecisionProvider } from '../core/interfaces.ts';
import type {
  CreatePermDockOptions,
  DecideOptions,
  PermDock,
  WhereResult,
} from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
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
import { resourceIdOf } from './shared.ts';

function withoutProviders<TUser, TPrincipal extends Principal>(
  policy: Policy<TUser, TPrincipal>,
): Policy<TUser, TPrincipal> {
  if (policy.providers === undefined || policy.providers.length === 0) {
    return policy;
  }
  return freezeDeep(
    compact<Policy<TUser, TPrincipal>>({
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
      case 'insufficient-user-authentication':
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

function wrap(
  dock: PermDock,
  policy: Policy,
  subject: Subject,
  providers: readonly DecisionProvider[],
): PdpPermDock {
  const decideLocal = dock.decide as (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ) => Decision;

  const decide = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): Promise<Decision> => {
    const local = decideLocal(permission, data, options);
    const provider = providerFor(providers, permission);
    if (provider === undefined || isLocalShortCircuit(local)) {
      return Promise.resolve(local);
    }
    return provider.decide({
      permission,
      data,
      subject,
      local,
    });
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

  const simulate = ((
    input:
      | readonly (readonly [Permission, unknown?])[]
      | Parameters<PermDock['simulate']>[0],
  ) => {
    if (isReadonlyArray(input)) {
      return Promise.all(
        input.map(([permission, data]) =>
          decide(permission, data, { source: 'simulate' }),
        ),
      );
    }
    if (isArazzoSimulateInput(input)) {
      return dock.simulate(input);
    }
    return wrap(
      dock.simulate(
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
  }) as PdpPermDock['simulate'];

  return {
    can,
    decide,
    assert,
    async filter<T>(
      permission: Permission<string, T, 'instance'>,
      rows: readonly T[],
      options?: DecideOptions,
    ): Promise<T[]> {
      const next = { ...options, source: 'filter' as const };
      const provider = providerFor(providers, permission);
      const ids =
        provider?.permitted === undefined || subject.principal === null
          ? undefined
          : await provider.permitted({ permission, subject });
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
    pick: dock.pick.bind(dock),
    async where(permission: Permission): Promise<WhereResult> {
      const provider = providerFor(providers, permission);
      if (provider === undefined) {
        return dock.where(permission);
      }
      const ids =
        provider.permitted === undefined || subject.principal === null
          ? undefined
          : await provider.permitted({ permission, subject });
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
      const local = dock.where(permission);
      const hasLocal =
        local.condition.op !== 'or' || local.condition.conditions.length > 0;
      return hasLocal
        ? {
            condition: { op: 'and', conditions: [local.condition, remote] },
            partial: local.partial,
          }
        : { condition: remote, partial: true };
    },
    actions: dock.actions.bind(dock),
    simulate,
    snapshot: dock.snapshot.bind(dock),
    on: dock.on.bind(dock),
    tenant: (id: string): PdpPermDock => {
      const next = dock.tenant(id);
      return wrap(next, policy, next.subject, providers);
    },
    team: (id: string): PdpPermDock => {
      const next = dock.team(id);
      return wrap(next, policy, next.subject, providers);
    },
    memberships: dock.memberships.bind(dock),
    tenants: dock.tenants.bind(dock),
    heldRoles: dock.heldRoles.bind(dock),
    audiences: dock.audiences.bind(dock),
    assignableRoles: dock.assignableRoles.bind(dock),
    assignablePermissions: dock.assignablePermissions.bind(dock),
    decideRoleChange: dock.decideRoleChange.bind(dock),
    loadRelations: dock.loadRelations.bind(dock),
    whoCan: dock.whoCan.bind(dock),
    activate: dock.activate.bind(dock),
    permissions: dock.permissions,
    roles: dock.roles,
    plans: dock.plans,
    subject,
  };
}

export async function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
>(
  policy: Policy<TUser, TPrincipal>,
  user: TUser | null,
  options: CreatePermDockOptions = {},
): Promise<PdpPermDock> {
  const localPolicy = withoutProviders(policy);
  const dock = await createCore(localPolicy, user, options);
  return wrap(dock, localPolicy, dock.subject, policy.providers ?? []);
}
