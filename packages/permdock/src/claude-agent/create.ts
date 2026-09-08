import type { ToolMap } from '../agent/types.ts';
import type { ApprovalStore } from '../approvals/types.ts';
import type {
  DecisionSink,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { Policy } from '../core/policy.ts';

import { createAgentKernel } from '../agent/kernel.ts';
import { compact } from '../core/compact.ts';

export type ClaudeAgentContext = {
  readonly approval?: string;
  readonly token?: string;
  readonly [key: string]: unknown;
};

export type ClaudeAgentPermDockOptions = {
  readonly subject: (context: ClaudeAgentContext) => unknown;
  readonly actor?: (context: ClaudeAgentContext) => unknown;
  readonly tenant?:
    | string
    | ((
        context: ClaudeAgentContext,
      ) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};

export type PermissionResult =
  | {
      readonly behavior: 'allow';
      readonly updatedInput: Record<string, unknown>;
    }
  | { readonly behavior: 'deny'; readonly message: string };

export type PermissionRequestHookInput = {
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly approval?: string;
  readonly token?: string;
};

export type PermissionRequestHookOutput = {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PermissionRequest';
    readonly decision?: PermissionResult;
  };
  readonly additionalContext?: string;
  readonly token?: string;
};

export type ClaudeAgentPermDock = {
  readonly canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options?: ClaudeAgentContext,
  ) => Promise<PermissionResult | null>;
  readonly permissionRequestHook: (
    input: PermissionRequestHookInput,
  ) => Promise<PermissionRequestHookOutput>;
};

function resumeTokenOf(
  context: ClaudeAgentContext | undefined,
): string | undefined {
  if (context === undefined) {
    return undefined;
  }
  if (typeof context.approval === 'string' && context.approval !== '') {
    return context.approval;
  }
  if (typeof context.token === 'string' && context.token !== '') {
    return context.token;
  }
  return undefined;
}

function asInput(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

export function createPermDock(
  policy: Policy,
  options: ClaudeAgentPermDockOptions,
): ClaudeAgentPermDock {
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
    adapter: 'claude-agent',
  });

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    context: ClaudeAgentContext = {},
  ): Promise<PermissionResult | null> => {
    const verdict = await kernel.decideTool(
      toolName,
      input,
      context,
      compact({ resumeToken: resumeTokenOf(context) }),
    );
    if (verdict.outcome === 'granted') {
      return { behavior: 'allow', updatedInput: input };
    }
    if (verdict.outcome === 'denied') {
      return { behavior: 'deny', message: verdict.reason };
    }
    return null;
  };

  const permissionRequestHook = async (
    input: PermissionRequestHookInput,
  ): Promise<PermissionRequestHookOutput> => {
    const context = compact<ClaudeAgentContext>({
      approval: input.approval,
      token: input.token,
    });
    const verdict = await kernel.decideTool(
      input.tool_name,
      input.tool_input,
      context,
      compact({ resumeToken: resumeTokenOf(context) }),
    );
    if (verdict.outcome === 'granted') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedInput: asInput(input.tool_input),
          },
        },
      };
    }
    if (verdict.outcome === 'denied') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: verdict.reason },
        },
      };
    }
    return compact<PermissionRequestHookOutput>({
      hookSpecificOutput: { hookEventName: 'PermissionRequest' },
      additionalContext: `${verdict.summary} Token: ${verdict.token}.`,
      token: verdict.token,
    });
  };

  return { canUseTool, permissionRequestHook };
}
