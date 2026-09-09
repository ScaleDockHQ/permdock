import type { ToolMap } from '../agent/types.ts';
import type { ApprovalRequest, ApprovalStore } from '../approvals/types.ts';
import type {
  DecisionSink,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { Principal } from '../core/subject.ts';

import { createAgentKernel } from '../agent/kernel.ts';
import { inspectApproval } from '../approvals/helpers.ts';
import { memoryApprovalStore } from '../approvals/store.ts';
import { compact } from '../core/compact.ts';

export type OpenAiContext = {
  readonly user?: unknown;
  readonly agentId?: string;
  readonly approval?: string;
  readonly token?: string;
  readonly [key: string]: unknown;
};

export type OpenAiPermDockOptions<TUser = unknown> = {
  readonly subject: (context: OpenAiContext) => TUser | Promise<TUser>;
  readonly actor?: (context: OpenAiContext) => unknown;
  readonly tenant?:
    | string
    | ((
        context: OpenAiContext,
      ) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};

export type OpenAiTool = {
  readonly name: string;
};

export type OpenAiInterruption = {
  readonly callId: string;
  readonly rawItem?: {
    readonly name?: string;
    readonly arguments?: unknown;
  };
};

export type OpenAiRunState = {
  approve(interruption: OpenAiInterruption): void | Promise<void>;
  reject(
    interruption: OpenAiInterruption,
    options?: { readonly message?: string },
  ): void | Promise<void>;
};

export type OpenAiPermDock = {
  readonly needsApproval: (
    permission: Permission,
  ) => (context: OpenAiContext, args: unknown) => Promise<boolean>;
  readonly guardTools: <T extends OpenAiTool>(
    tools: readonly T[],
    context: OpenAiContext,
  ) => Promise<readonly T[]>;
  readonly resolveInterruptions: (
    state: OpenAiRunState,
    interruptions: readonly OpenAiInterruption[],
    options: { readonly context: OpenAiContext },
  ) => Promise<readonly ApprovalRequest[]>;
  readonly permdock: (context: OpenAiContext) => Promise<PermDock>;
};

function resumeTokenOf(context: OpenAiContext): string | undefined {
  if (typeof context.approval === 'string' && context.approval !== '') {
    return context.approval;
  }
  if (typeof context.token === 'string' && context.token !== '') {
    return context.token;
  }
  return undefined;
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: OpenAiPermDockOptions<TUser>,
): OpenAiPermDock {
  const store = options.store ?? memoryApprovalStore();
  const tokensByCall = new Map<string, string>();
  const kernel = createAgentKernel(policy, {
    ...compact({
      actor: options.actor,
      tenant: options.tenant,
      memberships: options.memberships,
      customRoles: options.customRoles,
      sink: options.sink,
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

  const needsApproval =
    (permission: Permission) =>
    async (context: OpenAiContext, args: unknown): Promise<boolean> => {
      const toolName = byPermission.get(permission.key);
      if (toolName === undefined) {
        return true;
      }
      const verdict = await kernel.decideTool(
        toolName,
        args,
        context,
        compact({ resumeToken: resumeTokenOf(context) }),
      );
      return verdict.outcome !== 'granted';
    };

  const guardTools = async <T extends OpenAiTool>(
    tools: readonly T[],
    context: OpenAiContext,
  ): Promise<readonly T[]> => {
    const allowed = await kernel.allowedToolNames(context);
    return tools.filter((tool) => allowed.has(tool.name));
  };

  const resolveOne = async (
    state: OpenAiRunState,
    interruption: OpenAiInterruption,
    context: OpenAiContext,
  ): Promise<ApprovalRequest | null> => {
    const toolName = interruption.rawItem?.name;
    if (toolName === undefined) {
      await state.reject(interruption, { message: 'approval-not-found' });
      return null;
    }
    const storedToken = tokensByCall.get(interruption.callId);
    const inspected =
      storedToken === undefined
        ? undefined
        : await inspectApproval(store, storedToken);
    if (inspected !== undefined && inspected.ok) {
      const verdict = await kernel.decideTool(
        toolName,
        interruption.rawItem?.arguments,
        context,
        compact({ resumeToken: storedToken }),
      );
      if (verdict.outcome === 'granted') {
        await state.approve(interruption);
        return null;
      }
      await state.reject(interruption, {
        message:
          verdict.outcome === 'denied' ? verdict.reason : 'approval-mismatch',
      });
      return null;
    }
    if (inspected !== undefined && !inspected.ok) {
      await state.reject(interruption, { message: inspected.detail });
      return null;
    }
    const verdict = await kernel.decideTool(
      toolName,
      interruption.rawItem?.arguments,
      context,
    );
    if (verdict.outcome === 'granted') {
      await state.approve(interruption);
      return null;
    }
    if (verdict.outcome === 'denied') {
      await state.reject(interruption, { message: verdict.reason });
      return null;
    }
    tokensByCall.set(interruption.callId, verdict.token);
    return (await store.get(verdict.token)) ?? null;
  };

  const resolveInterruptions = async (
    state: OpenAiRunState,
    interruptions: readonly OpenAiInterruption[],
    resolveOptions: { readonly context: OpenAiContext },
  ): Promise<readonly ApprovalRequest[]> => {
    const resolved = await Promise.all(
      interruptions.map((interruption) =>
        resolveOne(state, interruption, resolveOptions.context),
      ),
    );
    return resolved.filter((record) => record !== null);
  };

  return {
    needsApproval,
    guardTools,
    resolveInterruptions,
    permdock: (context) => kernel.instance(context),
  };
}
