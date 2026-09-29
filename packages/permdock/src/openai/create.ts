import type { ToolMap } from '../agent/types.ts';
import type { ApprovalRequest, ApprovalStore } from '../approvals/types.ts';
import type { PolicySource } from '../core/hosted.ts';
import type {
  DecisionSink,
  LimitStore,
  EntitlementSource,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { Delegation, Principal } from '../core/subject.ts';

import { approvalTokenOf, createAgentKernel } from '../agent/kernel.ts';
import { memoryApprovalStore } from '../approvals/store.ts';
import { compact } from '../core/compact.ts';

/** The app context passed to `run(agent, input, { context })`. */
export type OpenAiContext = {
  readonly user?: unknown;
  readonly agentId?: string;
  readonly permdockApproval?: string;
  readonly [key: string]: unknown;
};

/** Structural `RunContext` from `@openai/agents`: the app context sits under `context`. */
export type OpenAiRunContext = {
  readonly context?: unknown;
};

export type OpenAiPermDockOptions<TUser = unknown> = {
  readonly subject: (context: OpenAiContext) => TUser | Promise<TUser>;
  readonly actor?: (context: OpenAiContext) => unknown;
  readonly delegation?: (
    context: OpenAiContext,
  ) => Delegation | undefined | Promise<Delegation | undefined>;
  readonly tenant?:
    | string
    | ((
        context: OpenAiContext,
      ) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  readonly entitlements?: EntitlementSource;
  readonly customRoles?: RoleSource;
  /** Hosted grants, read once per instance; see `PolicySource`. */
  readonly policies?: PolicySource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  readonly snapshots?: SnapshotSource;
};

export type OpenAiTool = {
  readonly name: string;
};

/** Structural `RunToolApprovalItem` from `@openai/agents`. */
export type OpenAiInterruption = {
  readonly type?: string;
  readonly name?: string | undefined;
  readonly arguments?: string | undefined;
  readonly rawItem?: {
    readonly type?: string;
    readonly callId?: string;
    readonly name?: string;
    readonly arguments?: unknown;
  };
};

/** Structural `RunState` from `@openai/agents`. */
export type OpenAiRunState<TItem> = {
  approve(item: TItem, options?: { alwaysApprove?: boolean }): unknown;
  reject(
    item: TItem,
    options?: { alwaysReject?: boolean; message?: string },
  ): unknown;
};

export type OpenAiPermDock = {
  /** A `ToolApprovalFunction`: pass it as a tool's `needsApproval`. */
  readonly needsApproval: (
    permission: Permission,
  ) => (
    runContext: OpenAiRunContext | undefined,
    input: unknown,
    callId?: string,
  ) => Promise<boolean>;
  readonly guardTools: <T extends OpenAiTool>(
    tools: readonly T[],
    context: OpenAiContext,
  ) => Promise<readonly T[]>;
  readonly resolveInterruptions: <TItem extends OpenAiInterruption>(
    state: OpenAiRunState<TItem>,
    interruptions: readonly TItem[],
    options: { readonly context: OpenAiContext },
  ) => Promise<readonly ApprovalRequest[]>;
  readonly permdock: (context: OpenAiContext) => Promise<PermDock>;
};

function appContext(runContext: OpenAiRunContext | undefined): OpenAiContext {
  const context = runContext?.context;
  return typeof context === 'object' && context !== null
    ? (context as OpenAiContext)
    : {};
}

type ParsedCall =
  | { readonly ok: true; readonly name: string; readonly args: unknown }
  | { readonly ok: false };

function parseCall(item: OpenAiInterruption): ParsedCall {
  const name = item.name ?? item.rawItem?.name;
  if (typeof name !== 'string') {
    return { ok: false };
  }
  const raw = item.arguments ?? item.rawItem?.arguments;
  if (typeof raw !== 'string') {
    return typeof raw === 'object' && raw !== null
      ? { ok: true, name, args: raw }
      : { ok: false };
  }
  try {
    return { ok: true, name, args: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: OpenAiPermDockOptions<TUser>,
): OpenAiPermDock {
  const store = options.store ?? memoryApprovalStore();
  const kernel = createAgentKernel(policy, {
    ...compact({
      actor: options.actor,
      delegation: options.delegation,
      tenant: options.tenant,
      memberships: options.memberships,
      entitlements: options.entitlements,
      customRoles: options.customRoles,
      policies: options.policies,
      sink: options.sink,
      limits: options.limits,
      snapshots: options.snapshots,
    }),
    subject: options.subject,
    tools: options.tools,
    store,
    adapter: 'openai',
  });

  const byPermission = new Map<string, string>();
  for (const [name, binding] of Object.entries(options.tools)) {
    byPermission.set(binding.permission.key, name);
  }

  // A denial also pauses the run: `resolveInterruptions` rejects it with the
  // reason, so the model sees why instead of the tool running.
  const needsApproval =
    (permission: Permission) =>
    async (
      runContext: OpenAiRunContext | undefined,
      input: unknown,
    ): Promise<boolean> => {
      const toolName = byPermission.get(permission.key);
      if (toolName === undefined) {
        return true;
      }
      const context = appContext(runContext);
      const binding = options.tools[toolName];
      if (binding === undefined) {
        return true;
      }
      try {
        const dock = await kernel.instance(context);
        const can = dock.can as (next: Permission, row?: unknown) => boolean;
        if (binding.data === undefined) {
          return !can(permission);
        }
        const data: unknown = await binding.data(input);
        if (data === null || data === undefined) {
          return true;
        }
        return !can(permission, data);
      } catch {
        return true;
      }
    };

  const guardTools = async <T extends OpenAiTool>(
    tools: readonly T[],
    context: OpenAiContext,
  ): Promise<readonly T[]> => {
    const allowed = await kernel.allowedToolNames(context);
    return tools.filter((tool) => allowed.has(tool.name));
  };

  const resolveOne = async <TItem extends OpenAiInterruption>(
    state: OpenAiRunState<TItem>,
    item: TItem,
    context: OpenAiContext,
  ): Promise<ApprovalRequest | null> => {
    const call = parseCall(item);
    if (!call.ok) {
      await state.reject(item, { message: 'Denied: unreadable tool call.' });
      return null;
    }
    const verdict = await kernel.decideTool(
      call.name,
      call.args,
      context,
      compact({ resumeToken: approvalTokenOf(context) }),
    );
    if (verdict.outcome === 'granted') {
      await state.approve(item);
      return null;
    }
    if (verdict.outcome === 'denied') {
      await state.reject(item, { message: verdict.reason });
      return null;
    }
    try {
      return await store.get(verdict.token);
    } catch {
      return null;
    }
  };

  const resolveInterruptions = async <TItem extends OpenAiInterruption>(
    state: OpenAiRunState<TItem>,
    interruptions: readonly TItem[],
    resolveOptions: { readonly context: OpenAiContext },
  ): Promise<readonly ApprovalRequest[]> => {
    const resolved = [];
    for (const item of interruptions) {
      // oxlint-disable-next-line no-await-in-loop -- approve / reject mutate the run state in interruption order
      resolved.push(await resolveOne(state, item, resolveOptions.context));
    }
    return resolved.filter((record) => record !== null);
  };

  return {
    needsApproval,
    guardTools,
    resolveInterruptions,
    permdock: (context) => kernel.instance(context),
  };
}
