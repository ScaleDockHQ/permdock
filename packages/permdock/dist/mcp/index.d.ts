import { r as AuthorizationDetail } from "../subject-BcgWbogX.js";
import { o as Policy, v as Permission } from "../policy-DsqYfECx.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
import { c as RoleSource, d as SnapshotSource, r as DecisionSink, s as MembershipSource } from "../interfaces-B19qT0zU.js";
import { a as OtelOptions } from "../types-DnMGsJ22.js";
import { StandardSchemaV1 } from "@standard-schema/spec";
//#region src/mcp/types.d.ts
type McpAuthInfo = {
  readonly token?: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly expiresAt?: number;
  readonly extra?: {
    readonly subject?: unknown;
    readonly authorizationDetails?: readonly AuthorizationDetail[];
    readonly approval?: string;
  };
};
type McpToolResult = {
  readonly isError?: boolean;
  readonly content: readonly {
    readonly type: "text";
    readonly text: string;
  }[];
  readonly structuredContent?: unknown;
};
type McpToolConfig = {
  readonly permission: Permission;
  readonly inputSchema?: StandardSchemaV1;
  readonly data?: (args: unknown) => object | null | Promise<object | null>;
  readonly description?: string;
};
type McpToolHandler = (args: unknown, extra?: unknown) => Promise<McpToolResult> | McpToolResult;
type McpServerLike = {
  registerTool: (name: string, config: Readonly<Record<string, unknown>>, handler: McpToolHandler) => unknown;
};
type GuardedMcpServer<S extends McpServerLike> = S & {
  registerTool: (name: string, config: McpToolConfig, handler: McpToolHandler) => unknown;
  listTools: (authInfo: McpAuthInfo) => Promise<readonly {
    readonly name: string;
  }[]>;
};
type McpPermDockOptions = {
  readonly subject: (authInfo: McpAuthInfo) => unknown;
  readonly tenant?: string | ((authInfo: McpAuthInfo) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
};
type McpPermDock = {
  readonly protectServer: <S extends McpServerLike>(server: S) => GuardedMcpServer<S>;
};
//#endregion
//#region src/mcp/create.d.ts
export declare function createPermDock(policy: Policy, options: McpPermDockOptions): McpPermDock;
//#endregion
//#region src/mcp/errors.d.ts
export declare class InsufficientScopeError extends Error {
  override readonly name: "InsufficientScopeError";
  readonly code: "insufficient_scope";
  readonly missing: string;
  readonly scope: string;
  readonly wwwAuthenticate: string;
  constructor(missing: string, held: readonly string[]);
}
//#endregion
export type { GuardedMcpServer, McpAuthInfo, McpPermDock, McpPermDockOptions, McpServerLike, McpToolConfig, McpToolHandler, McpToolResult };