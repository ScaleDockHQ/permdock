import { A as SnapshotV2, B as Decision, J as Permission, X as PermissionTree } from "../policy-CrXDbTAD.js";
import { StandardSchemaV1 } from "@standard-schema/spec";
//#region src/webmcp/types.d.ts
type WebMcpClientStatus = "ready" | "pending" | "stale" | "server-only";
type WebMcpPermDock = {
  can(permission: Permission, data?: unknown): boolean;
  decide(permission: Permission, data?: unknown): Decision;
  snapshot(): SnapshotV2 | string | Promise<SnapshotV2 | string>;
  tenant?(id: string): WebMcpPermDock;
  subscribe?(listener: () => void): () => void;
  status?(permission?: Permission, data?: unknown): WebMcpClientStatus;
};
type WebMcpToolContent = {
  readonly type: "text";
  readonly text: string;
};
type WebMcpToolResult = {
  readonly isError?: boolean;
  readonly content: readonly WebMcpToolContent[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
};
type WebMcpToolHandler = (input: unknown) => Promise<unknown>;
type WebMcpToolAnnotations = {
  readonly readOnlyHint?: boolean;
  readonly untrustedContentHint?: boolean;
};
type WebMcpRegisteredTool = {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: WebMcpToolAnnotations;
  execute(input: unknown): Promise<WebMcpToolResult>;
};
type ModelContext = {
  registerTool(tool: WebMcpRegisteredTool, options?: {
    readonly signal?: AbortSignal;
  }): {
    readonly unregister?: () => void;
  };
};
type WebMcpApprovalRequest = {
  readonly permission: Permission;
  readonly decision: Extract<Decision, {
    readonly outcome: "approval-required";
  }>;
  readonly input: unknown;
};
type RegisterToolsOptions = {
  readonly permdock: WebMcpPermDock;
  readonly handlers?: Readonly<Record<string, WebMcpToolHandler>>;
  readonly signal?: AbortSignal;
  readonly tenant?: string;
  readonly tenantKey?: string;
  readonly schema?: StandardSchemaV1;
  readonly untrustedContentHint?: boolean;
  readonly onApprovalRequired?: (request: WebMcpApprovalRequest) => Promise<boolean | undefined>;
  readonly warn?: (message: string) => void;
};
type RegisterToolsHandle = {
  readonly unregister: () => void;
};
type PermissionGroup = PermissionTree | Permission;
//#endregion
//#region src/webmcp/register.d.ts
export declare function registerTools(modelContext: ModelContext | null | undefined, group: PermissionGroup, options: RegisterToolsOptions): RegisterToolsHandle;
//#endregion
export type { ModelContext, PermissionGroup, RegisterToolsHandle, RegisterToolsOptions, WebMcpApprovalRequest, WebMcpClientStatus, WebMcpPermDock, WebMcpRegisteredTool, WebMcpToolAnnotations, WebMcpToolHandler, WebMcpToolResult };