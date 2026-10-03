import type { Decision } from '../core/decision.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy, PolicyVocabulary } from '../core/policy.ts';
import type { Actor, Delegation, Principal } from '../core/subject.ts';
import type {
  AgentKernelOptions,
  DecideToolOptions,
  ToolBinding,
  ToolVerdict,
} from './types.ts';

import { resumeDecision, storedApprovalToken } from '../approvals/helpers.ts';
import { compact } from '../core/compact.ts';
import { mayUse } from '../core/may-use.ts';
import { createPermDock as createCorePermDock } from '../core/permdock.ts';
import { modelReason, thrownReason, unmappedReason } from './reason.ts';

function asActor(value: unknown): Actor | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: checked above to be a non-array object; id and kind are typeof-checked below.
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

/** The resume token an agent run carries under the namespaced `permdockApproval` key. */
export function approvalTokenOf(context: unknown): string | undefined {
  if (context === null || typeof context !== 'object') {
    return undefined;
  }
  // SAFETY: checked above to be a non-null object; the token is typeof-checked below.
  const token = (context as { readonly permdockApproval?: unknown })
    .permdockApproval;
  return typeof token === 'string' && token !== '' ? token : undefined;
}

export function idOf(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') {
    return undefined;
  }
  // SAFETY: checked above to be a non-null object; id is typeof-checked below.
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

function runDecide(
  permdock: PermDock,
  permission: Permission,
  data: unknown,
  adapter: string,
): Decision {
  // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
  return (
    permdock.decide as (
      next: Permission,
      row?: unknown,
      decideOptions?: {
        readonly source: 'adapter';
        readonly adapter: string;
        readonly boundary: 'tool-args';
      },
    ) => Decision
  )(
    permission,
    data,
    compact({
      source: 'adapter' as const,
      adapter,
      boundary: 'tool-args' as const,
    }),
  );
}

export function createAgentKernel<
  TContext,
  TUser = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, Principal, V>,
  options: AgentKernelOptions<TContext, TUser>,
): {
  /** One instance per context object while a call is in flight; later calls re-read the subject. */
  readonly instance: (context: TContext) => Promise<PermDock<V>>;
  readonly decideTool: (
    toolName: string,
    args: unknown,
    context: TContext,
    decideOptions?: DecideToolOptions,
  ) => Promise<ToolVerdict>;
  readonly evaluate: (
    binding: ToolBinding,
    toolName: string,
    args: unknown,
    context: TContext,
    decideOptions?: DecideToolOptions,
  ) => Promise<ToolVerdict>;
  /** The approval token a call would park under, without touching the store. */
  readonly tokenFor: (
    binding: ToolBinding,
    args: unknown,
    context: TContext,
  ) => Promise<string | undefined>;
  readonly allowedToolNames: (
    context: TContext,
  ) => Promise<ReadonlySet<string>>;
} {
  const cache = new WeakMap<object, Promise<PermDock<V>>>();

  const instance = (context: TContext): Promise<PermDock<V>> => {
    if (typeof context === 'object' && context !== null) {
      const hit = cache.get(context);
      if (hit !== undefined) {
        return hit;
      }
    }
    const built = (async (): Promise<PermDock<V>> => {
      let user: TUser | null = null;
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
      let delegation: Delegation | undefined;
      if (options.delegation !== undefined) {
        try {
          delegation = await options.delegation(context);
        } catch {
          delegation = undefined;
        }
      }
      const tenant = await resolveTenant(options.tenant, context);
      return createCorePermDock(
        policy,
        user,
        compact({
          tenant,
          actor,
          delegation,
          memberships: options.memberships,
          relations: options.relations,
          entitlements: options.entitlements,
          customRoles: options.customRoles,
          policies: options.policies,
          sink: options.sink,
          limits: options.limits,
        }),
      );
    })();
    if (typeof context === 'object' && context !== null) {
      cache.set(context, built);
      const release = (): void => {
        if (cache.get(context) === built) {
          cache.delete(context);
        }
      };
      built.then(release, release);
    }
    return built;
  };

  const evaluate = async (
    binding: ToolBinding,
    toolName: string,
    args: unknown,
    context: TContext,
    decideOptions: DecideToolOptions = {},
  ): Promise<ToolVerdict> => {
    try {
      const permdock = await instance(context);
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
              permdock.subject.principal?.id,
            ),
          };
        }
      }
      const raw = runDecide(
        permdock,
        binding.permission,
        data,
        options.adapter,
      );
      const decision = await resumeDecision({
        decision: raw,
        permission: binding.permission,
        subject: permdock.subject,
        store: options.store,
        resource: resourceRef(binding.permission, data),
        adapter: options.adapter,
        token:
          decideOptions.resumeToken ??
          (await storedApprovalToken(
            options.store,
            raw,
            decideOptions.denyPending === true,
          )),
      });
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
            permdock.subject.principal?.id,
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
          permdock.subject.principal?.id,
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

  const tokenFor = async (
    binding: ToolBinding,
    args: unknown,
    context: TContext,
  ): Promise<string | undefined> => {
    try {
      const permdock = await instance(context);
      let data: unknown;
      if (binding.data !== undefined) {
        data = await binding.data(args);
        if (data === null || data === undefined) {
          return undefined;
        }
      }
      const raw = runDecide(
        permdock,
        binding.permission,
        data,
        options.adapter,
      );
      return raw.outcome === 'approval-required' ? raw.token : undefined;
    } catch {
      return undefined;
    }
  };

  const decideTool = (
    toolName: string,
    args: unknown,
    context: TContext,
    decideOptions: DecideToolOptions = {},
  ): Promise<ToolVerdict> => {
    const binding = options.tools[toolName];
    if (binding === undefined) {
      return Promise.resolve({
        outcome: 'denied',
        decision: null,
        permission: undefined,
        reason: unmappedReason(toolName),
      });
    }
    return evaluate(binding, toolName, args, context, decideOptions);
  };

  const allowedToolNames = async (
    context: TContext,
  ): Promise<ReadonlySet<string>> => {
    const permdock = await instance(context);
    const allowed = new Set<string>();
    for (const [name, binding] of Object.entries(options.tools)) {
      if (mayUse(permdock, binding.permission)) {
        allowed.add(name);
      }
    }
    return allowed;
  };

  return { instance, decideTool, evaluate, tokenFor, allowedToolNames };
}
