import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { Decision } from '../core/decision.ts';
import type { SnapshotV2 } from '../core/interfaces.ts';
import type { Permission, PermissionTree } from '../core/permissions.ts';

export type WebMcpClientStatus = 'ready' | 'pending' | 'stale' | 'server-only';

export type WebMcpPermDock = {
  can(permission: Permission, data?: unknown): boolean;
  decide(permission: Permission, data?: unknown): Decision;
  snapshot(): SnapshotV2 | string | Promise<SnapshotV2 | string>;
  tenant?(id: string): WebMcpPermDock;
  subscribe?(listener: () => void): () => void;
  status?(permission?: Permission, data?: unknown): WebMcpClientStatus;
};

export type WebMcpToolContent = {
  readonly type: 'text';
  readonly text: string;
};

export type WebMcpToolResult = {
  readonly isError?: boolean;
  readonly content: readonly WebMcpToolContent[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
};

export type WebMcpToolHandler = (input: unknown) => Promise<unknown>;

export type WebMcpToolAnnotations = {
  readonly readOnlyHint?: boolean;
  readonly untrustedContentHint?: boolean;
};

export type WebMcpRegisteredTool = {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: WebMcpToolAnnotations;
  execute(input: unknown): Promise<WebMcpToolResult>;
};

export type ModelContext = {
  registerTool(
    tool: WebMcpRegisteredTool,
    options?: { readonly signal?: AbortSignal },
  ): { readonly unregister?: () => void };
};

export type WebMcpApprovalRequest = {
  readonly permission: Permission;
  readonly decision: Extract<
    Decision,
    { readonly outcome: 'approval-required' }
  >;
  readonly input: unknown;
};

export type RegisterToolsOptions = {
  readonly permdock: WebMcpPermDock;
  readonly handlers?: Readonly<Record<string, WebMcpToolHandler>>;
  readonly signal?: AbortSignal;
  readonly tenant?: string;
  readonly tenantKey?: string;
  readonly schema?: StandardSchemaV1;
  readonly untrustedContentHint?: boolean;
  readonly onApprovalRequired?: (
    request: WebMcpApprovalRequest,
  ) => Promise<boolean | undefined>;
  readonly warn?: (message: string) => void;
};

export type RegisterToolsHandle = {
  readonly unregister: () => void;
};

export type PermissionGroup = PermissionTree | Permission;
