import type { ApprovalStore } from "../approvals/types.ts";
import type { TenantScope } from "../core/adapter-context.ts";
import type { Decision } from "../core/decision.ts";
import type { ApprovalHint, ProblemDetails } from "../core/errors.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { PermDock, SnapshotOptions } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { PolicyVocabulary } from "../core/policy-types.ts";
import type { Report, RequestContext } from "../core/request-context.ts";
import type { RevocationFeed } from "../core/revocations.ts";
import type { Snapshot } from "../core/snapshot-types.ts";
import type { Actor, Subject } from "../core/subject.ts";
import type { PermDockWrap } from "../core/wrap.ts";
import type { PdpFactory, PdpPermDock } from "../pdp/types.ts";
import type { Connection, ConnectionOptions } from "./connection.ts";
import type { evaluationsHandler } from "./evaluations.ts";
import type { WebBotAuthVerifier } from "./web-bot-auth.ts";

export type ServerPermDockOptions<TUser = unknown> = InstanceOptions & {
  /**
   * The user, or a full `Subject` (core then skips `policy.subject`); `null` is
   * anonymous.
   */
  readonly subject: (
    request: Request,
  ) => TUser | Subject | null | Promise<TUser | Subject | null>;
  readonly actor?: (request: Request) => unknown;
  /** `webBotAuthVerifier(options)`; a verified bot becomes the actor. */
  readonly webBotAuth?: WebBotAuthVerifier;
  readonly tenant?:
    | string
    | ((request: Request) => string | undefined | Promise<string | undefined>);
  readonly store?: ApprovalStore;
  /** Ends or revalidates open connections; never a decision input. */
  readonly revocations?: RevocationFeed;
  /**
   * `getPermDock` from `permdock/pdp`: `protect` then decides delegated
   * permissions through the remote PDP. The instance handlers receive stays
   * synchronous and keeps denying delegated permissions (`pdp-unavailable`).
   */
  readonly pdp?: PdpFactory;
  /** Added as `approval` to every `approval-required` problem. */
  readonly approval?: ApprovalHint;
  readonly operations?: OperationScopes;
  /**
   * Replaces the response of a refused guard. A status below 300, or a throw,
   * keeps the default response and reports through `on('error')`.
   */
  readonly deniedResponse?: DeniedResponse;
  /**
   * Request values merged into `subject.context`, under `policy.context`. Only
   * values the server derived belong here, never client input. A throw or a
   * value that is not a JSON object adds nothing and reports through
   * `on('error')`.
   */
  readonly context?: (
    request: Request,
  ) => RequestContext | undefined | Promise<RequestContext | undefined>;
  /**
   * Wraps each instance the factory builds; build it with `wrapPermDock` to
   * cover derived instances.
   */
  readonly wrap?: PermDockWrap;
  /**
   * The `adapter` label on decision events, revocations and approvals. Defaults
   * to `server`.
   */
  readonly adapter?: string;
};

/**
 * What `deniedResponse` receives: the refusal and the default Problem Details
 * for it.
 */
export type DeniedResponseEvent = {
  readonly decision: Exclude<Decision, { readonly outcome: "granted" }>;
  readonly problem: ProblemDetails;
  readonly request: Request | undefined;
};

/**
 * Returns Problem Details with extra members, a `Response`, or nothing for the
 * default.
 */
export type DeniedResponse = (
  event: DeniedResponseEvent,
) =>
  | ProblemDetails
  | Response
  | undefined
  | Promise<ProblemDetails | Response | undefined>;

export type OperationScopes = {
  oauthScopesForRequest: (
    method: string,
    path: string,
  ) => readonly string[] | undefined;
};

export type Guard<T = unknown, V extends PolicyVocabulary = PolicyVocabulary> =
  | {
      readonly ok: true;
      readonly permdock: PermDock<V>;
      readonly decision: Extract<Decision, { readonly outcome: "granted" }>;
      readonly data: T;
    }
  | {
      readonly ok: false;
      readonly response: Response;
      /**
       * The refusal behind `response`; absent for a missing row or a bad
       * signature.
       */
      readonly decision?: Exclude<Decision, { readonly outcome: "granted" }>;
    };

/**
 * What `protect(null, …)` resolves to: the route declares OAuth scopes and no
 * permission, so there is no decision to return.
 */
export type ScopeGuard<
  T = unknown,
  V extends PolicyVocabulary = PolicyVocabulary,
> =
  | {
      readonly ok: true;
      readonly permdock: PermDock<V>;
      readonly decision?: undefined;
      readonly data: T;
    }
  | {
      readonly ok: false;
      readonly response: Response;
      /**
       * The refusal behind `response`; absent for a missing row or a bad
       * signature.
       */
      readonly decision?: Exclude<Decision, { readonly outcome: "granted" }>;
    };

export type Loader<T> = (
  request: Request,
) => T | null | undefined | Promise<T | null | undefined>;

/**
 * `protect(permission, data?, options?)`, or `protect(null, data?, {
 * oauthScopes })` for a route that needs a signed-in principal and, from a
 * delegated token, one of the OAuth scopes it declares, but no permission.
 */
export type Protect<
  V extends PolicyVocabulary = PolicyVocabulary,
  TArgs extends unknown[] = [],
> = {
  <T = unknown>(
    permission: Permission,
    data?: Loader<T>,
    protectOptions?: ProtectOptions,
  ): (request: Request, ...args: TArgs) => Promise<Guard<T, V>>;
  <T = unknown>(
    permission: null,
    data?: Loader<T>,
    protectOptions?: ProtectOptions,
  ): (request: Request, ...args: TArgs) => Promise<ScopeGuard<T, V>>;
  <T = unknown>(
    permission: Permission | null,
    data?: Loader<T>,
    protectOptions?: ProtectOptions,
  ): (
    request: Request,
    ...args: TArgs
  ) => Promise<Guard<T, V> | ScopeGuard<T, V>>;
};

export type OpenApiHooks = {
  readonly security: (permission: Permission) => {
    readonly security: readonly Record<string, readonly string[]>[];
    readonly "x-permdock-permissions": readonly string[];
  };
  readonly securitySchemes: () => Readonly<Record<string, unknown>>;
};

export type ProtectOptions = {
  /**
   * `true` when `data` returns a row the server loaded itself, to skip schema
   * validation. Anything else is validated against the resource schema before
   * the check.
   */
  readonly trusted?: boolean;
  /**
   * The OAuth scopes that reach the route: a delegated token holding none of
   * them is refused with `insufficient_scope`. Default the `operations` entry
   * for the request. Required, here or there, for `protect(null)`.
   */
  readonly oauthScopes?: readonly string[];
  /** The field being read or written; only grants whose `fields` cover it match. */
  readonly field?: string;
  /** Adds the evaluation `trace` to the guard's decision. */
  readonly explain?: boolean;
};

export type SnapshotQuery = {
  /**
   * The active tenant; defaults to the `tenant` option resolved from the
   * request.
   */
  readonly tenant?: string;
  readonly include?: SnapshotOptions["include"];
  readonly tenants?: "all";
};

/**
 * What `createPermDock` from `permdock/server` returns. Every member takes an
 * optional `TenantScope`, so an adapter resolves the tenant from its own
 * framework context.
 */
export type ServerPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly getPermDock: (
    request: Request,
    scope?: TenantScope,
  ) => Promise<PermDock<V>>;
  /**
   * The JSON snapshot for a loader (React Router, TanStack Start, SvelteKit,
   * Nuxt), built from the request's cached subject. Send it with
   * `snapshotHeaders(snapshot)`.
   */
  readonly getSnapshot: (
    request: Request,
    query?: SnapshotQuery,
  ) => Promise<Snapshot>;
  readonly protect: Protect<V, [scope?: TenantScope]>;
  /**
   * `protect` against an instance the adapter already holds, such as a gateway
   * connection's: the same OAuth scope check, loader, decision and approval
   * resume. A method, so a `ServerPermDock<V>` stays assignable to
   * `ServerPermDock`.
   */
  // oxlint-disable-next-line typescript/method-signature-style -- bivariant in V
  protectOn<T = unknown>(
    instance: PermDock<V>,
    permission: Permission | null,
    data?: () => T | null | undefined | Promise<T | null | undefined>,
    protectOptions?: ProtectOptions,
    request?: Request,
  ): Promise<Guard<T, V> | ScopeGuard<T, V>>;
  /** A long-lived connection for a stream or socket opened by `request`. */
  readonly connection: <T = unknown>(
    request: Request,
    options?: ConnectionOptions<T>,
    scope?: TenantScope,
  ) => Promise<Connection>;
  /**
   * Lets `to`, a second `Request` an adapter built for the same incoming
   * request (to re-read a body a parser consumed), reuse the subject and actor
   * already resolved for `from`.
   */
  readonly shareSubject: (from: Request, to: Request) => void;
  readonly problem: (
    decision: Decision,
    init?: { readonly permission?: Permission; readonly instance?: string },
  ) => Response;
  readonly openapi: OpenApiHooks;
  readonly permdockHandler: (
    scope?: (request: Request) => TenantScope | Promise<TenantScope>,
  ) => ReturnType<typeof evaluationsHandler>;
};

export type Built<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly permdock: PermDock<V>;
  readonly remote: PdpPermDock | undefined;
  readonly report: Report;
};

export type Resolved<TUser> = {
  readonly user: TUser | Subject | null;
  readonly actor: Actor | undefined;
  readonly context: RequestContext | undefined;
  /** Errors from resolving the request, replayed to every `on('error')` handler. */
  readonly errors: readonly unknown[];
};
