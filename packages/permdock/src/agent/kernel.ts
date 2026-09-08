import type { ApprovalInspectResult } from '../approvals/types.ts';
import type { Decision } from '../core/decision.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { Actor } from '../core/subject.ts';
import type {
  AgentKernelOptions,
  DecideToolOptions,
  ToolVerdict,
} from './types.ts';

import { inspectApproval, requestApproval } from '../approvals/helpers.ts';
import { compact } from '../core/compact.ts';
import { createPermDock as createCorePermDock } from '../core/permdock.ts';
import { modelReason, thrownReason, unmappedReason } from './reason.ts';

function asActor(value: unknown): Actor | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as { readonly id?: unknown; readonly kind?: unknown };
  if (typeof record.id !== 'string' || typeof record.kind !== 'string') {
    return undefined;
  }
  return { id: record.id, kind: record.kind };
}

async function resolveTenant<TContext>(
  tenant: AgentKernelOptions<TContext>['tenant'],
  context: TContext,
): Promise<string | undefined> {
  if (tenant === undefined || typeof tenant === 'string') {
    return tenant;
  }
  try {
    return await tenant(context);
  } catch {
    return undefined;
  }
}

export function idOf(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') {
    return undefined;
  }
  const id = (data as { readonly id?: unknown }).id;
  if (typeof id === 'string' || typeof id === 'number') {
    return String(id);
  }
  return undefined;
}

export function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  return compact({
    type: permission.resource,
    id: idOf(data),
  });
}

function approvalDenied(
  detail: string,
): Extract<Decision, { readonly outcome: 'denied' }> {
  return {
    outcome: 'denied',
    denials: [{ role: null, reason: 'approval', detail }],
    alternatives: [],
  };
}

function resumeMatches(
  inspected: ApprovalInspectResult,
  permission: Permission,
  resource: { readonly type: string; readonly id?: string },
  decision: Extract<Decision, { readonly outcome: 'approval-required' }>,
): boolean {
  if (!inspected.ok) {
    return false;
  }
  if (inspected.request.token !== decision.token) {
    return false;
  }
  if (inspected.request.permission !== permission.key) {
    return false;
  }
  if (
    inspected.request.resource.id !== undefined &&
    inspected.request.resource.id !== resource.id
  ) {
    return false;
  }
  return true;
}

async function applyResume(
  decision: Decision,
  permission: Permission,
  dock: PermDock,
  store: AgentKernelOptions<unknown>['store'],
  resource: { readonly type: string; readonly id?: string },
  adapter: string,
  resumeToken: string | undefined,
): Promise<Decision> {
  if (resumeToken === undefined) {
    if (decision.outcome === 'approval-required' && store !== undefined) {
      await requestApproval(
        store,
        decision,
        compact({
          permission,
          resource,
          subject: dock.subject,
          adapter,
        }),
      );
    }
    return decision;
  }
  if (store === undefined) {
    return approvalDenied('approval-not-found');
  }
  const inspected = await inspectApproval(store, resumeToken);
  if (!inspected.ok) {
    return approvalDenied(inspected.detail);
  }
  if (decision.outcome === 'granted' || decision.outcome === 'denied') {
    return decision;
  }
  if (!resumeMatches(inspected, permission, resource, decision)) {
    return approvalDenied('approval-mismatch');
  }
  const principal = dock.subject.principal;
  if (principal === null) {
    return approvalDenied('approval-mismatch');
  }
  return {
    outcome: 'granted',
    subject: { ...dock.subject, principal },
    matched: decision.grant,
    token: decision.token,
  };
}

function runDecide(
  dock: PermDock,
  permission: Permission,
  data: unknown,
  adapter: string,
): Decision {
  return (
    dock.decide as (
      next: Permission,
      row?: unknown,
      decideOptions?: {
        readonly source: 'adapter';
        readonly adapter: string;
      },
    ) => Decision
  )(permission, data, compact({ source: 'adapter' as const, adapter }));
}

export function hasAnyGrant(
  policy: Policy,
  dock: PermDock,
  permission: Permission,
): boolean {
  const principal = dock.subject.principal;
  if (principal === null) {
    return false;
  }
  const names = new Set(principal.roles ?? []);
  for (const membership of principal.memberships ?? []) {
    for (const role of membership.roles) {
      names.add(role);
    }
  }
  for (const role of policy.roles) {
    if (!names.has(role.name)) {
      continue;
    }
    for (const grant of role.grants) {
      if (grant.effect === 'allow' && grant.permission.key === permission.key) {
        return true;
      }
    }
  }
  return false;
}

export function createAgentKernel<TContext>(
  policy: Policy,
  options: AgentKernelOptions<TContext>,
): {
  readonly instance: (context: TContext) => Promise<PermDock>;
  readonly decideTool: (
    toolName: string,
    args: unknown,
    context: TContext,
    decideOptions?: DecideToolOptions,
  ) => Promise<ToolVerdict>;
  readonly allowedToolNames: (
    context: TContext,
  ) => Promise<ReadonlySet<string>>;
} {
  const cache = new WeakMap<object, Promise<PermDock>>();

  const instance = (context: TContext): Promise<PermDock> => {
    if (typeof context === 'object' && context !== null) {
      const hit = cache.get(context);
      if (hit !== undefined) {
        return hit;
      }
    }
    const built = (async (): Promise<PermDock> => {
      let user: unknown = null;
      try {
        user = await options.subject(context);
      } catch {
        user = null;
      }
      let actor: Actor | undefined;
      if (options.actor !== undefined) {
        try {
          actor = asActor(await options.actor(context));
        } catch {
          actor = undefined;
        }
      }
      const tenant = await resolveTenant(options.tenant, context);
      return createCorePermDock(
        policy,
        user,
        compact({
          tenant,
          actor,
          memberships: options.memberships,
          customRoles: options.customRoles,
          sink: options.sink,
        }),
      );
    })();
    if (typeof context === 'object' && context !== null) {
      cache.set(context, built);
    }
    return built;
  };

  const decideTool = async (
    toolName: string,
    args: unknown,
    context: TContext,
    decideOptions: DecideToolOptions = {},
  ): Promise<ToolVerdict> => {
    const binding = options.tools[toolName];
    if (binding === undefined) {
      return {
        outcome: 'denied',
        decision: null,
        permission: undefined,
        reason: unmappedReason(toolName),
      };
    }
    try {
      const dock = await instance(context);
      let data: unknown;
      if (binding.data !== undefined) {
        data = await binding.data(args);
        if (data === null || data === undefined) {
          const decision = {
            outcome: 'denied' as const,
            denials: [{ role: null, reason: 'validation' as const }],
            alternatives: [],
          };
          return {
            outcome: 'denied',
            decision,
            permission: binding.permission,
            reason: modelReason(
              decision,
              binding.permission,
              dock.subject.principal?.id,
            ),
          };
        }
      }
      const raw = runDecide(dock, binding.permission, data, options.adapter);
      const decision = await applyResume(
        raw,
        binding.permission,
        dock,
        options.store,
        resourceRef(binding.permission, data),
        options.adapter,
        decideOptions.resumeToken,
      );
      if (decision.outcome === 'granted') {
        return {
          outcome: 'granted',
          decision,
          permission: binding.permission,
          data,
        };
      }
      if (decision.outcome === 'approval-required') {
        return {
          outcome: 'approval-required',
          decision,
          permission: binding.permission,
          data,
          token: decision.token,
          summary: modelReason(
            decision,
            binding.permission,
            dock.subject.principal?.id,
          ),
        };
      }
      return {
        outcome: 'denied',
        decision,
        permission: binding.permission,
        reason: modelReason(
          decision,
          binding.permission,
          dock.subject.principal?.id,
        ),
      };
    } catch {
      return {
        outcome: 'denied',
        decision: null,
        permission: binding.permission,
        reason: thrownReason(toolName),
      };
    }
  };

  const allowedToolNames = async (
    context: TContext,
  ): Promise<ReadonlySet<string>> => {
    const dock = await instance(context);
    const allowed = new Set<string>();
    for (const [name, binding] of Object.entries(options.tools)) {
      if (hasAnyGrant(policy, dock, binding.permission)) {
        allowed.add(name);
      }
    }
    return allowed;
  };

  return { instance, decideTool, allowedToolNames };
}
