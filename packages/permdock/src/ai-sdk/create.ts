import type { ToolMap } from '../agent/types.ts';
import type { ApprovalStore } from '../approvals/types.ts';
import type {
  DecisionSink,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { Principal } from '../core/subject.ts';

import { createAgentKernel } from '../agent/kernel.ts';
import { compact } from '../core/compact.ts';

export type AiSdkContext = {
  readonly runtimeContext?: unknown;
  readonly approval?: string;
  readonly token?: string;
  readonly [key: string]: unknown;
};

export type AiSdkPermDockOptions<TUser = unknown> = {
  readonly subject: (context: AiSdkContext) => TUser | Promise<TUser>;
  readonly actor?: (context: AiSdkContext) => unknown;
  readonly tenant?:
    | string
    | ((
        context: AiSdkContext,
      ) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};

export type ToolApprovalStatus =
  | 'approved'
  | { readonly type: 'denied'; readonly reason: string }
  | {
      readonly type: 'user-approval';
      readonly reason: string;
      readonly token: string;
    };

export type ToolApprovalCall = {
  readonly toolCall: {
    readonly toolName: string;
    readonly input?: unknown;
    readonly args?: unknown;
  };
  readonly runtimeContext?: unknown;
};

export type LanguageModelMiddleware = {
  readonly specificationVersion: 'v3';
  readonly transformParams: (options: {
    readonly params: {
      readonly tools?:
        | Readonly<Record<string, unknown>>
        | readonly { readonly name?: string }[];
    };
  }) => Promise<{
    readonly tools?:
      | Readonly<Record<string, unknown>>
      | readonly { readonly name?: string }[];
  }>;
};

export type AiSdkPermDock = {
  readonly toolApproval: (
    call: ToolApprovalCall,
  ) => Promise<ToolApprovalStatus>;
  readonly capabilityMiddleware: LanguageModelMiddleware;
  readonly needsApproval: (
    permission: Permission,
  ) => (input: unknown, context?: AiSdkContext) => Promise<boolean>;
};

function contextOf(call: ToolApprovalCall): AiSdkContext {
  const runtime =
    call.runtimeContext !== null && typeof call.runtimeContext === 'object'
      ? (call.runtimeContext as AiSdkContext)
      : {};
  return compact<AiSdkContext>({
    ...runtime,
    runtimeContext: call.runtimeContext,
  });
}

function resumeTokenOf(context: AiSdkContext): string | undefined {
  if (typeof context.approval === 'string' && context.approval !== '') {
    return context.approval;
  }
  if (typeof context.token === 'string' && context.token !== '') {
    return context.token;
  }
  return undefined;
}

function isToolList(
  tools:
    | Readonly<Record<string, unknown>>
    | readonly { readonly name?: string }[],
): tools is readonly { readonly name?: string }[] {
  return Array.isArray(tools);
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: AiSdkPermDockOptions<TUser>,
): AiSdkPermDock {
  const kernel = createAgentKernel(policy, {
    ...compact({
      actor: options.actor,
      tenant: options.tenant,
      memberships: options.memberships,
      customRoles: options.customRoles,
      store: options.store,
      sink: options.sink,
      snapshots: options.snapshots,
    }),
    subject: options.subject,
    tools: options.tools,
    adapter: 'ai-sdk',
  });

  const byPermission = new Map<string, string>();
  for (const [name, binding] of Object.entries(options.tools)) {
    byPermission.set(binding.permission.key, name);
  }

  const toolApproval = async (
    call: ToolApprovalCall,
  ): Promise<ToolApprovalStatus> => {
    const context = contextOf(call);
    const args = call.toolCall.input ?? call.toolCall.args;
    const verdict = await kernel.decideTool(
      call.toolCall.toolName,
      args,
      context,
      compact({ resumeToken: resumeTokenOf(context) }),
    );
    if (verdict.outcome === 'granted') {
      return 'approved';
    }
    if (verdict.outcome === 'approval-required') {
      return {
        type: 'user-approval',
        reason: verdict.summary,
        token: verdict.token,
      };
    }
    return { type: 'denied', reason: verdict.reason };
  };

  const capabilityMiddleware: LanguageModelMiddleware = {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => {
      const tools = params.tools;
      if (tools === undefined) {
        return params;
      }
      const context: AiSdkContext = {};
      const allowed = await kernel.allowedToolNames(context);
      if (isToolList(tools)) {
        return {
          ...params,
          tools: tools.filter((tool) => {
            const name = tool.name;
            return typeof name === 'string' && allowed.has(name);
          }),
        };
      }
      const next: Record<string, unknown> = {};
      for (const [name, tool] of Object.entries(tools)) {
        if (allowed.has(name)) {
          next[name] = tool;
        }
      }
      return { ...params, tools: next };
    },
  };

  const needsApproval =
    (permission: Permission) =>
    async (input: unknown, context: AiSdkContext = {}): Promise<boolean> => {
      const toolName = byPermission.get(permission.key);
      if (toolName === undefined) {
        return true;
      }
      const verdict = await kernel.decideTool(
        toolName,
        input,
        context,
        compact({ resumeToken: resumeTokenOf(context) }),
      );
      return verdict.outcome !== 'granted';
    };

  return { toolApproval, capabilityMiddleware, needsApproval };
}
