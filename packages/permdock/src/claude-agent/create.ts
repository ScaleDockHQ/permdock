import type { ToolMap, ToolVerdict } from '../agent/types.ts';
import type { ApprovalStore } from '../approvals/types.ts';
import type {
  DecisionSink,
  LimitStore,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Policy } from '../core/policy.ts';
import type { Principal } from '../core/subject.ts';

import { createAgentKernel } from '../agent/kernel.ts';
import { compact } from '../core/compact.ts';

/** Structural `McpServerProvenance` from `@anthropic-ai/claude-agent-sdk`. */
export type ClaudeMcpServer = {
  readonly name: string;
  readonly source: string;
};

/**
 * What `subject`, `actor` and `tenant` receive: the `canUseTool` options or
 * the hook input. The subject comes from the app that started the query,
 * never from these fields.
 */
export type ClaudeAgentContext = {
  readonly toolName: string;
  readonly mcpServer?: ClaudeMcpServer;
  readonly sessionId?: string;
  readonly agentId?: string;
};

export type ClaudeAgentPermDockOptions<TUser = unknown> = {
  readonly subject: (context: ClaudeAgentContext) => TUser | Promise<TUser>;
  readonly actor?: (context: ClaudeAgentContext) => unknown;
  readonly tenant?:
    | string
    | ((
        context: ClaudeAgentContext,
      ) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
  /** MCP server sources whose `mcp__*` tools may be decided; default `['sdk']`. */
  readonly mcpSources?: readonly string[];
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  readonly snapshots?: SnapshotSource;
};

export type PermissionResult =
  | {
      readonly behavior: 'allow';
      readonly updatedInput: Record<string, unknown>;
    }
  | { readonly behavior: 'deny'; readonly message: string };

/** Structural `canUseTool` options from `@anthropic-ai/claude-agent-sdk`. */
export type CanUseToolOptions = {
  readonly signal?: AbortSignal;
  readonly mcpServer?: ClaudeMcpServer;
  readonly agentID?: string;
  readonly toolUseID?: string;
};

/** Structural `HookInput`; only `PermissionRequest` events are answered. */
export type PermissionRequestHookInput = {
  readonly hook_event_name: string;
  readonly session_id?: string;
  readonly agent_id?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly mcp_server?: ClaudeMcpServer;
};

export type PermissionRequestHookOutput =
  | {
      readonly hookSpecificOutput: {
        readonly hookEventName: 'PermissionRequest';
        readonly decision: PermissionResult;
      };
    }
  | Record<string, never>;

export type ClaudeAgentPermDock = {
  /** A `CanUseTool`: pass it as the query's `canUseTool` option. */
  readonly canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options?: CanUseToolOptions,
  ) => Promise<PermissionResult>;
  /** A `HookCallback` for the `PermissionRequest` event. */
  readonly permissionRequestHook: (
    input: PermissionRequestHookInput,
    toolUseID?: string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<PermissionRequestHookOutput>;
  readonly permdock: (context: ClaudeAgentContext) => Promise<PermDock>;
};

const MCP_PREFIX = 'mcp__';

function asInput(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function untrustedServer(
  context: ClaudeAgentContext,
  sources: readonly string[],
): string | undefined {
  if (!context.toolName.startsWith(MCP_PREFIX)) {
    return undefined;
  }
  const server = context.mcpServer;
  if (server === undefined) {
    return `Denied: ${context.toolName} has no MCP server provenance.`;
  }
  if (!sources.includes(server.source)) {
    return `Denied: ${context.toolName} comes from an untrusted MCP server source.`;
  }
  if (!context.toolName.startsWith(`${MCP_PREFIX}${server.name}__`)) {
    return `Denied: ${context.toolName} is not served by the MCP server that claims it.`;
  }
  return undefined;
}

function toResult(verdict: ToolVerdict, input: unknown): PermissionResult {
  if (verdict.outcome === 'granted') {
    return { behavior: 'allow', updatedInput: asInput(input) };
  }
  if (verdict.outcome === 'denied') {
    return { behavior: 'deny', message: verdict.reason };
  }
  return {
    behavior: 'deny',
    message: `${verdict.summary} Approval ${verdict.token} is pending; retry the call once it is approved.`,
  };
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: ClaudeAgentPermDockOptions<TUser>,
): ClaudeAgentPermDock {
  const sources = options.mcpSources ?? ['sdk'];
  const kernel = createAgentKernel<ClaudeAgentContext, TUser>(policy, {
    ...compact({
      actor: options.actor,
      tenant: options.tenant,
      memberships: options.memberships,
      customRoles: options.customRoles,
      store: options.store,
      sink: options.sink,
      limits: options.limits,
      snapshots: options.snapshots,
    }),
    subject: options.subject,
    tools: options.tools,
    adapter: 'claude-agent',
  });

  const decide = async (
    context: ClaudeAgentContext,
    input: unknown,
  ): Promise<PermissionResult> => {
    const untrusted = untrustedServer(context, sources);
    if (untrusted !== undefined) {
      return { behavior: 'deny', message: untrusted };
    }
    const verdict = await kernel.decideTool(context.toolName, input, context);
    return toResult(verdict, input);
  };

  const canUseTool = (
    toolName: string,
    input: Record<string, unknown>,
    sdkOptions: CanUseToolOptions = {},
  ): Promise<PermissionResult> =>
    decide(
      compact<ClaudeAgentContext>({
        toolName,
        mcpServer: sdkOptions.mcpServer,
        agentId: sdkOptions.agentID,
      }),
      input,
    );

  const permissionRequestHook = async (
    input: PermissionRequestHookInput,
  ): Promise<PermissionRequestHookOutput> => {
    if (
      input.hook_event_name !== 'PermissionRequest' ||
      typeof input.tool_name !== 'string'
    ) {
      return {};
    }
    const decision = await decide(
      compact<ClaudeAgentContext>({
        toolName: input.tool_name,
        mcpServer: input.mcp_server,
        sessionId: input.session_id,
        agentId: input.agent_id,
      }),
      input.tool_input,
    );
    return {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
    };
  };

  return {
    canUseTool,
    permissionRequestHook,
    permdock: (context) => kernel.instance(context),
  };
}
