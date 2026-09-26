import type {
  CacheHint,
  Icon,
  McpServer,
  PromptCallback,
  ReadResourceCallback,
  ReadResourceTemplateCallback,
  RegisteredPrompt,
  RegisteredResource,
  RegisteredResourceTemplate,
  RegisteredTool,
  ResourceMetadata,
  ResourceTemplate,
  ScopeChallengeHandler,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
  Variables,
} from '@modelcontextprotocol/server';

import type { ApprovalStore } from '../approvals/types.ts';
import type {
  DecisionSink,
  LimitStore,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { Permission } from '../core/permissions.ts';
import type { Principal } from '../core/subject.ts';
import type { OtelOptions } from '../otel/types.ts';

/** The verified `AuthInfo` the MCP SDK's bearer auth puts on `ctx.http.authInfo`. */
export type McpAuthInfo = {
  readonly token?: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly expiresAt?: number;
  readonly resource?: URL;
  readonly extra?: Readonly<Record<string, unknown>>;
};

/** Base principal `subjectFromMcp` returns. */
export type McpPrincipal = Principal & {
  readonly issuer?: string;
  readonly claims?: Readonly<Record<string, unknown>>;
};

type InputOf<TInput> = TInput extends StandardSchemaWithJSON
  ? StandardSchemaWithJSON.InferOutput<TInput>
  : undefined;

type Guard<TArgs extends readonly unknown[]> = {
  readonly permission: Permission;
  /** Loads the row to decide on; `null` or a throw denies. */
  readonly data?: (...args: TArgs) => unknown;
};

export type McpToolConfig<
  TInput extends StandardSchemaWithJSON | undefined = undefined,
  TOutput extends StandardSchemaWithJSON | undefined = undefined,
> = Guard<[args: InputOf<TInput>]> & {
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: TInput;
  readonly outputSchema?: TOutput;
  readonly annotations?: ToolAnnotations;
  readonly icons?: Icon[];
  readonly scopeChallenge?: ScopeChallengeHandler;
  readonly _meta?: Record<string, unknown>;
};

export type McpResourceConfig<TArgs extends readonly unknown[]> = Guard<TArgs> &
  ResourceMetadata & {
    readonly cacheHint?: CacheHint;
    readonly scopeChallenge?: ScopeChallengeHandler;
  };

export type McpPromptConfig<
  TArgs extends StandardSchemaWithJSON | undefined = undefined,
> = Guard<[args: InputOf<TArgs>]> & {
  readonly title?: string;
  readonly description?: string;
  readonly argsSchema?: TArgs;
  readonly icons?: Icon[];
  readonly scopeChallenge?: ScopeChallengeHandler;
  readonly _meta?: Record<string, unknown>;
};

/** `McpServer` whose `register*` methods take a `permission` and decide first. */
export type GuardedMcpServer = Omit<
  McpServer,
  'registerTool' | 'registerResource' | 'registerPrompt'
> & {
  registerTool<
    TInput extends StandardSchemaWithJSON | undefined = undefined,
    TOutput extends StandardSchemaWithJSON | undefined = undefined,
  >(
    name: string,
    config: McpToolConfig<TInput, TOutput>,
    handler: ToolCallback<TInput>,
  ): RegisteredTool;
  registerResource(
    name: string,
    uri: string,
    config: McpResourceConfig<[uri: URL]>,
    read: ReadResourceCallback,
  ): RegisteredResource;
  registerResource(
    name: string,
    template: ResourceTemplate,
    config: McpResourceConfig<[uri: URL, variables: Variables]>,
    read: ReadResourceTemplateCallback,
  ): RegisteredResourceTemplate;
  registerPrompt<TArgs extends StandardSchemaWithJSON | undefined = undefined>(
    name: string,
    config: McpPromptConfig<TArgs>,
    handler: PromptCallback<TArgs>,
  ): RegisteredPrompt;
};

export type McpPermDockOptions<TUser = unknown> = {
  /** Receives the verified auth info, or `{}` on a transport without one (stdio). */
  readonly subject: (authInfo: McpAuthInfo) => TUser | Promise<TUser>;
  readonly tenant?:
    | string
    | ((
        authInfo: McpAuthInfo,
      ) => string | undefined | Promise<string | undefined>);
  /** Deny every call and list nothing when the transport carries no auth info. */
  readonly requireAuthInfo?: boolean;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
};

export type McpPermDock = {
  /** Call before registering anything: later `register*` calls must carry a `permission`. */
  readonly protectServer: (server: McpServer) => GuardedMcpServer;
};
