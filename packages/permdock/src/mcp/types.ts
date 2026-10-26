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
} from "@modelcontextprotocol/server";

import type { DeniedText } from "../agent/denied-text.ts";
import type { ApprovalStore } from "../approvals/types.ts";
import type { ClientNames } from "../core/clients.ts";
import type { ApprovalHint } from "../core/errors.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { Permission } from "../core/permission-types.ts";
import type { RequestContext } from "../core/request-context.ts";
import type { Delegation, Principal } from "../core/subject.ts";
import type { PermDockWrap } from "../core/wrap.ts";
import type { OtelWrap } from "../otel/types.ts";

/**
 * The verified `AuthInfo` the MCP SDK's bearer auth puts on
 * `ctx.http.authInfo`.
 */
export type McpAuthInfo = {
  readonly token?: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  readonly expiresAt?: number;
  readonly resource?: URL;
  /**
   * Stamped by the SDK's bearer-auth helpers from their `resourceMetadataUrl`
   * option.
   */
  readonly resourceMetadataUrl?: string;
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
  readonly oauthScopes?: readonly string[];
  readonly _meta?: Record<string, unknown>;
  /**
   * Decide again when the handler resolves, without consuming quota, and return
   * the refusal instead of the result unless the call is still allowed. The
   * re-check withholds the result; it cannot undo the work.
   */
  readonly longRunning?: boolean;
};

export type McpResourceConfig<TArgs extends readonly unknown[]> = Guard<TArgs> &
  ResourceMetadata & {
    readonly cacheHint?: CacheHint;
    readonly scopeChallenge?: ScopeChallengeHandler;
  };

/**
 * An MCP Apps view (`ui://`). Without `permission` it takes the permission of
 * the tool whose `_meta.ui.resourceUri` names it, and denies while no tool
 * does.
 */
export type McpUiResourceConfig = Omit<
  McpResourceConfig<[uri: URL]>,
  "permission"
> & { readonly permission?: Permission };

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
  "registerTool" | "registerResource" | "registerPrompt"
> & {
  registerTool: <
    TInput extends StandardSchemaWithJSON | undefined = undefined,
    TOutput extends StandardSchemaWithJSON | undefined = undefined,
  >(
    name: string,
    config: McpToolConfig<TInput, TOutput>,
    handler: ToolCallback<TInput>,
  ) => RegisteredTool;
  registerResource: {
    (
      name: string,
      uri: `ui://${string}`,
      config: McpUiResourceConfig,
      read: ReadResourceCallback,
    ): RegisteredResource;
    (
      name: string,
      uri: string,
      config: McpResourceConfig<[uri: URL]>,
      read: ReadResourceCallback,
    ): RegisteredResource;
    (
      name: string,
      template: ResourceTemplate,
      config: McpResourceConfig<[uri: URL, variables: Variables]>,
      read: ReadResourceTemplateCallback,
    ): RegisteredResourceTemplate;
  };
  registerPrompt: <
    TArgs extends StandardSchemaWithJSON | undefined = undefined,
  >(
    name: string,
    config: McpPromptConfig<TArgs>,
    handler: PromptCallback<TArgs>,
  ) => RegisteredPrompt;
};

/** A tool config when the tool's own procedure decides: no loader, no re-check. */
export type McpProcedureToolConfig<
  TInput extends StandardSchemaWithJSON | undefined = undefined,
  TOutput extends StandardSchemaWithJSON | undefined = undefined,
> = Omit<
  McpToolConfig<TInput, TOutput>,
  "permission" | "data" | "longRunning"
> & {
  /** Overrides `permissionFor(name)`. */
  readonly permission?: Permission;
};

/**
 * `GuardedMcpServer` whose tools are listed and annotated by permission but
 * decided by the procedure they call.
 */
export type ProcedureMcpServer = Omit<GuardedMcpServer, "registerTool"> & {
  registerTool: <
    TInput extends StandardSchemaWithJSON | undefined = undefined,
    TOutput extends StandardSchemaWithJSON | undefined = undefined,
  >(
    name: string,
    config: McpProcedureToolConfig<TInput, TOutput>,
    handler: ToolCallback<TInput>,
  ) => RegisteredTool;
};

/**
 * Tools whose handler calls a procedure that already runs `protect`, such as an
 * oRPC procedure through `call()`. `tools/list` and annotations use the
 * permission; the call itself is not guarded, so each call decides once.
 */
export type McpProcedureEnforcement = {
  readonly enforce: "procedure";
  /**
   * The permission of the tool `name`; `permissionOf(procedure)` from
   * `permdock/orpc` reads it. `undefined` throws at registration.
   */
  readonly permissionFor: (name: string) => Permission | undefined;
  readonly oauthScopesFor?: (name: string) => readonly string[] | undefined;
};

/**
 * Receives an error a check threw: a loader, `decide`, an approval input or a
 * subject a list cannot build. The call still refuses; a sink that throws is
 * ignored.
 */
export type McpOnError = (
  error: unknown,
  context: { readonly permission: string | null; readonly name: string },
) => void;

export type McpPermDockOptions<TUser = unknown> = InstanceOptions & {
  /**
   * Receives the verified auth info, or `{}` on a transport without one
   * (stdio).
   */
  readonly subject: (authInfo: McpAuthInfo) => TUser | Promise<TUser>;
  /**
   * The `kind` of the actor built from `authInfo.clientId`; `'mcp-client'` when
   * absent. `'oauth-client'` decides the token under the kind
   * `subjectFromSupabase`, `subjectFromJwt` and `permdock/a2a` give an OAuth
   * client, so one policy delegation covers the token on every surface.
   */
  readonly actorKind?: string;
  /**
   * Replaces the actor built from `authInfo.clientId`, `actorKind` and
   * `clients`. Read it from the verified `authInfo`, never from tool
   * arguments.
   */
  readonly actor?: (authInfo: McpAuthInfo) => unknown;
  /**
   * Replaces the delegation read from `authInfo.scopes` and
   * `authInfo.extra.authorization_details`.
   */
  readonly delegation?: (
    authInfo: McpAuthInfo,
  ) => Delegation | undefined | Promise<Delegation | undefined>;
  /**
   * Names for OAuth client ids (`ClientNames`): the actor gets `client` set to
   * the name of `authInfo.clientId`, which a policy delegation matches with
   * `to: { kind, client }`.
   */
  readonly clients?: ClientNames;
  readonly tenant?:
    | string
    | ((
        authInfo: McpAuthInfo,
      ) => string | undefined | Promise<string | undefined>);
  /** Deny every call and list nothing when the transport carries no auth info. */
  readonly requireAuthInfo?: boolean;
  /**
   * This server's RFC 8707 resource identifier. A token whose
   * `authInfo.resource` is absent or different is refused with
   * `invalid_token`.
   */
  readonly resource?: string | URL;
  /**
   * Where a human approves. With `at` set, `approval-required` answers a client
   * that supports URL elicitation with an `input_required` result.
   */
  readonly approval?: ApprovalHint;
  /**
   * Where the user re-authenticates; `acr_values` and `max_age` are appended to
   * `at`.
   */
  readonly stepUp?: { readonly at: string };
  /**
   * Seals the approval token into `requestState`. Pass the codec from the SDK's
   * `createRequestStateCodec` when the server verifies request state.
   */
  readonly requestState?: {
    readonly mint: (token: string, context?: never) => Promise<string>;
  };
  readonly store?: ApprovalStore;
  /** `(permdock) => withOtel(permdock, options)` from `permdock/otel`. */
  readonly otel?: OtelWrap;
  /**
   * Wraps each instance after `otel`; build it with `wrapPermDock` to cover
   * derived instances.
   */
  readonly wrap?: PermDockWrap;
  /**
   * Request values merged into `subject.context`, under `policy.context`. Read
   * them from the verified `authInfo`, never from tool arguments.
   */
  readonly context?: (
    authInfo: McpAuthInfo,
  ) => RequestContext | undefined | Promise<RequestContext | undefined>;
  /**
   * Replaces the text of a refusal. `isError`, `structuredContent` and the
   * approval shape stay as PermDock built them.
   */
  readonly deniedText?: DeniedText;
};

export type McpPermDock = {
  /**
   * Call before registering anything: later `register*` calls must carry a
   * `permission`.
   */
  readonly protectServer: {
    (server: McpServer, onError?: McpOnError): GuardedMcpServer;
    (
      server: McpServer,
      options: McpProcedureEnforcement,
      onError?: McpOnError,
    ): ProcedureMcpServer;
  };
};
