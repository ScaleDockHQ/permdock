import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { ApprovalStore } from '../approvals/types.ts';
import type {
  DecisionSink,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { Permission } from '../core/permissions.ts';
import type { AuthorizationDetail } from '../core/subject.ts';
import type { OtelOptions } from '../otel/types.ts';

export type McpAuthInfo = {
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

export type McpToolResult = {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly structuredContent?: unknown;
};

export type McpToolConfig = {
  readonly permission: Permission;
  readonly inputSchema?: StandardSchemaV1;
  readonly data?: (args: unknown) => object | null | Promise<object | null>;
  readonly description?: string;
};

export type McpToolHandler = (
  args: unknown,
  extra?: unknown,
) => Promise<McpToolResult> | McpToolResult;

export type McpServerLike = {
  registerTool: (
    name: string,
    config: Readonly<Record<string, unknown>>,
    handler: McpToolHandler,
  ) => unknown;
};

export type GuardedMcpServer<S extends McpServerLike> = S & {
  registerTool: (
    name: string,
    config: McpToolConfig,
    handler: McpToolHandler,
  ) => unknown;
  listTools: (
    authInfo: McpAuthInfo,
  ) => Promise<readonly { readonly name: string }[]>;
};

export type McpPermDockOptions = {
  readonly subject: (authInfo: McpAuthInfo) => unknown;
  readonly tenant?:
    | string
    | ((
        authInfo: McpAuthInfo,
      ) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
};

export type McpPermDock = {
  readonly protectServer: <S extends McpServerLike>(
    server: S,
  ) => GuardedMcpServer<S>;
};
