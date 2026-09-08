import { o as Policy } from "../policy-CL40bNGn.js";
import { s as ApprovalStore } from "../types-DwRNNTg4.js";
import { l as SnapshotSource, o as MembershipSource, r as DecisionSink, s as RoleSource } from "../interfaces-DMSVa7et.js";
import { t as ToolMap } from "../types-TiEQoW1J.js";
//#region src/claude-agent/create.d.ts
type ClaudeAgentContext = {
  readonly approval?: string;
  readonly token?: string;
  readonly [key: string]: unknown;
};
type ClaudeAgentPermDockOptions = {
  readonly subject: (context: ClaudeAgentContext) => unknown;
  readonly actor?: (context: ClaudeAgentContext) => unknown;
  readonly tenant?: string | ((context: ClaudeAgentContext) => string | undefined | Promise<string | undefined>);
  readonly tools: ToolMap;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};
type PermissionResult = {
  readonly behavior: "allow";
  readonly updatedInput: Record<string, unknown>;
} | {
  readonly behavior: "deny";
  readonly message: string;
};
type PermissionRequestHookInput = {
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly approval?: string;
  readonly token?: string;
};
type PermissionRequestHookOutput = {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PermissionRequest";
    readonly decision?: PermissionResult;
  };
  readonly additionalContext?: string;
  readonly token?: string;
};
type ClaudeAgentPermDock = {
  readonly canUseTool: (toolName: string, input: Record<string, unknown>, options?: ClaudeAgentContext) => Promise<PermissionResult | null>;
  readonly permissionRequestHook: (input: PermissionRequestHookInput) => Promise<PermissionRequestHookOutput>;
};
export declare function createPermDock(policy: Policy, options: ClaudeAgentPermDockOptions): ClaudeAgentPermDock;
//#endregion
export type { ClaudeAgentContext, ClaudeAgentPermDock, ClaudeAgentPermDockOptions, PermissionRequestHookInput, PermissionRequestHookOutput, PermissionResult };