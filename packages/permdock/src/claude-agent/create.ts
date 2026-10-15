import type { AgentPermDock } from "../agent/create.ts";
import type { AgentAdapterOptions, ToolVerdict } from "../agent/types.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Principal } from "../core/subject.ts";

import { agentRuntime } from "../agent/create.ts";
import { adapterOptions } from "../approvals/app.ts";
import { compact, isRecord } from "../core/compact.ts";

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

export type ClaudeAgentPermDockOptions<TUser = unknown> = AgentAdapterOptions<
  ClaudeAgentContext,
  TUser
> & {
  /** MCP server sources whose `mcp__*` tools may be decided; default `['sdk']`. */
  readonly mcpSources?: readonly string[];
};

export type PermissionResult =
  | {
      readonly behavior: "allow";
      readonly updatedInput: Record<string, unknown>;
    }
  | { readonly behavior: "deny"; readonly message: string };

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
        readonly hookEventName: "PermissionRequest";
        readonly decision: PermissionResult;
      };
    }
  | Record<string, never>;

export type ClaudeAgentPermDock<V extends PolicyVocabulary = PolicyVocabulary> =
  AgentPermDock<ClaudeAgentContext, V> & {
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
    readonly getPermDock: (context: ClaudeAgentContext) => Promise<PermDock<V>>;
  };

const MCP_PREFIX = "mcp__";

function asInput(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
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
  if (verdict.outcome === "granted") {
    return { behavior: "allow", updatedInput: asInput(input) };
  }
  if (verdict.outcome === "denied") {
    return { behavior: "deny", message: verdict.reason };
  }
  return {
    behavior: "deny",
    message: `${verdict.summary} Approval ${verdict.token} is pending; retry the call once it is approved.`,
  };
}

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  given: ClaudeAgentPermDockOptions<TUser>,
): ClaudeAgentPermDock<V> {
  const options = adapterOptions(policy, given);
  const sources = options.mcpSources ?? ["sdk"];
  const { agent, kernel } = agentRuntime(policy, options, "claude-agent");

  /** `null`: an unmapped tool under `unmapped: 'allow'`, which PermDock does not decide. */
  const decide = async (
    context: ClaudeAgentContext,
    input: unknown,
  ): Promise<PermissionResult | null> => {
    const untrusted = untrustedServer(context, sources);
    if (untrusted !== undefined) {
      return { behavior: "deny", message: untrusted };
    }
    if (
      options.unmapped === "allow" &&
      !Object.hasOwn(options.operations, context.toolName)
    ) {
      return null;
    }
    const verdict = await kernel.decideTool(context.toolName, input, context);
    return toResult(verdict, input);
  };

  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    sdkOptions: CanUseToolOptions = {},
  ): Promise<PermissionResult> =>
    (await decide(
      compact<ClaudeAgentContext>({
        toolName,
        mcpServer: sdkOptions.mcpServer,
        agentId: sdkOptions.agentID,
      }),
      input,
    )) ?? { behavior: "allow", updatedInput: input };

  const permissionRequestHook = async (
    input: PermissionRequestHookInput,
  ): Promise<PermissionRequestHookOutput> => {
    if (
      input.hook_event_name !== "PermissionRequest" ||
      typeof input.tool_name !== "string"
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
    if (decision === null) {
      return {};
    }
    return {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
    };
  };

  return Object.freeze({
    ...agent,
    canUseTool,
    permissionRequestHook,
  });
}
