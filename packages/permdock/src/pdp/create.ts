import type { Decision } from '../core/decision.ts';
import type { DecisionProvider } from '../core/interfaces.ts';
import type {
  CreatePermDockOptions,
  DecideOptions,
  PermDock,
} from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { Subject } from '../core/subject.ts';
import type { PdpPermDock } from './types.ts';

import { compact } from '../core/compact.ts';
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

function withoutProviders(policy: Policy): Policy {
  if (policy.providers === undefined || policy.providers.length === 0) {
    return policy;
  }
  return freezeDeep(
    compact<Policy>({
      permissions: policy.permissions,
      roles: policy.roles,
      rolesByName: policy.rolesByName,
      scopes: policy.scopes,
      subject: policy.subject,
      context: policy.context,
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
      case 'limit':
      case 'tenant-mismatch':
      case 'no-membership':
      case 'scope':
      case 'expired-membership':
      case 'unknown-role':
      case 'approval':
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
    if (Array.isArray(input)) {
      return Promise.all(
        input.map(([permission, data]) =>
          decide(permission, data, { source: 'simulate' }),
        ),
      );
    }
    return wrap(
      dock.simulate(input as Parameters<PermDock['simulate']>[0]),
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
      const decisions = await Promise.all(
        rows.map((row) =>
          decide(permission, row, { ...options, source: 'filter' }),
        ),
      );
      return rows.filter((_, index) => decisions[index]?.outcome === 'granted');
    },
    pick: dock.pick.bind(dock),
    where: dock.where.bind(dock),
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
    roles: dock.roles.bind(dock),
    assignable: dock.assignable.bind(dock),
    subject,
  };
}

export async function createPermDock(
  policy: Policy,
  user: unknown,
  options: CreatePermDockOptions = {},
): Promise<PdpPermDock> {
  const localPolicy = withoutProviders(policy);
  const dock = await createCore(localPolicy, user, options);
  return wrap(dock, localPolicy, dock.subject, policy.providers ?? []);
}
