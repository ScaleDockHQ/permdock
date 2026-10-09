import type { ApprovalStore } from "../approvals/types.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { RevocationFeed } from "../core/revocations.ts";
import type { Principal } from "../core/subject.ts";
import type { OtelWrap } from "../otel/types.ts";
import type { PdpFactory } from "../pdp/types.ts";
import type { Connection } from "./connection.ts";
import type { ServerKernel, TenantOption, TenantScope } from "./create.ts";
import type { WebBotAuthVerifier } from "./web-bot-auth.ts";

import { compact } from "../core/compact.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { createServerKernel, tenantScope } from "./create.ts";
import { invalidSignatureResponse } from "./web-bot-auth.ts";

/** The options of every framework adapter; `TContext` is what its callbacks receive. */
export type ServerAdapterOptions<TContext, TUser = unknown> = InstanceOptions &
  ServerAdapterServices & {
    readonly subject: (context: TContext) => TUser | Promise<TUser>;
    /** The agent or service acting for the subject; anything but an `Actor` is ignored. */
    readonly actor?: (context: TContext) => unknown;
    readonly tenant?: TenantOption<TContext>;
  };

/** The services an adapter hands to its kernel unchanged. */
export type ServerAdapterServices = {
  readonly store?: ApprovalStore;
  /** `createPermDock` from `permdock/pdp`; `protect` then decides delegated permissions remotely. */
  readonly pdp?: PdpFactory;
  /** `(permdock) => withOtel(permdock, options)` from `permdock/otel`. */
  readonly otel?: OtelWrap;
  /** `(request) => verifyWebBotAuth(request, options)`; a verified bot becomes the actor. */
  readonly webBotAuth?: WebBotAuthVerifier;
};

export type Attached<V extends PolicyVocabulary = PolicyVocabulary> =
  | { readonly ok: true; readonly permdock: PermDock<V> }
  | { readonly ok: false; readonly response: Response };

export type BoundKernel<TContext, V extends PolicyVocabulary> = {
  readonly kernel: ServerKernel<V>;
  /** The `Request` for `context`, built once and mapped back to it for the option callbacks. */
  readonly bind: (context: TContext) => Request;
  /**
   * A new `Request` for `context`, for a body a parser consumed since `bind`,
   * that reuses the subject already resolved for it.
   */
  readonly rebind: (context: TContext) => Request;
  readonly scopeOf: (context: TContext) => Promise<TenantScope>;
  /** The `permdockHandler` scope: the `tenant` option against the request's context. */
  readonly handlerScope: (request: Request) => Promise<TenantScope>;
  /** The instance for `context`; an invalid Web Bot Auth signature is its `401` response. */
  readonly attach: (context: TContext) => Promise<Attached<V>>;
};

/**
 * The kernel of a framework adapter, with the subject, actor and tenant
 * callbacks reading the framework context each `Request` was built from.
 */
export function bindKernel<
  TContext extends object,
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: ServerAdapterOptions<TContext, TUser> & {
    readonly revocations?: RevocationFeed;
  },
  adapter: string,
  toRequest: (context: TContext) => Request,
): BoundKernel<TContext, V> {
  const contexts = new WeakMap<Request, TContext>();
  const bound = new WeakMap<TContext, Request>();
  const kernel = createServerKernel(
    policy,
    compact({
      subject: (request: Request) => {
        const context = contexts.get(request);
        return context === undefined ? null : options.subject(context);
      },
      actor:
        options.actor === undefined
          ? undefined
          : (request: Request): unknown => {
              const context = contexts.get(request);
              return context === undefined
                ? undefined
                : options.actor?.(context);
            },
      ...instanceOptions(options),
      store: options.store,
      pdp: options.pdp,
      webBotAuth: options.webBotAuth,
      revocations: options.revocations,
      adapter,
      wrap: options.otel,
    }),
  );

  const bind = (context: TContext): Request => {
    const hit = bound.get(context);
    if (hit !== undefined) {
      return hit;
    }
    const request = toRequest(context);
    bound.set(context, request);
    contexts.set(request, context);
    return request;
  };

  const rebind = (context: TContext): Request => {
    const request = toRequest(context);
    contexts.set(request, context);
    const previous = bound.get(context);
    if (previous !== undefined) {
      kernel.shareSubject(previous, request);
    }
    return request;
  };

  const scopeOf = (context: TContext): Promise<TenantScope> =>
    tenantScope(options.tenant, context);

  const handlerScope = (request: Request): Promise<TenantScope> => {
    const context = contexts.get(request);
    return context === undefined
      ? Promise.resolve({ tenant: undefined })
      : scopeOf(context);
  };

  const attach = (context: TContext): Promise<Attached<V>> =>
    attached(async () =>
      kernel.permdock(bind(context), await scopeOf(context)),
    );

  return { kernel, bind, rebind, scopeOf, handlerScope, attach };
}

/** The instance `build` resolves; an invalid Web Bot Auth signature is its `401` response. */
export async function attached<V extends PolicyVocabulary>(
  build: () => Promise<PermDock<V>>,
): Promise<Attached<V>> {
  try {
    return { ok: true, permdock: await build() };
  } catch (error) {
    const response = invalidSignatureResponse(error);
    if (response === undefined) {
      throw error;
    }
    return { ok: false, response };
  }
}

/** Sets `permdock`, and `permdockData` when a loader returned a row, on a framework request or context. */
export function decorate<V extends PolicyVocabulary>(
  target: object,
  instance: PermDock<V>,
  data?: unknown,
): void {
  Object.assign(
    target,
    data === undefined
      ? { permdock: instance }
      : { permdock: instance, permdockData: data },
  );
}

/** One connection per socket: every handler of `socket` gets the promise the first one opened. */
export function socketConnection(
  sockets: WeakMap<object, Promise<Connection>>,
  socket: object,
  open: () => Promise<Connection>,
): Promise<Connection> {
  const hit = sockets.get(socket);
  if (hit !== undefined) {
    return hit;
  }
  const opened = open();
  sockets.set(socket, opened);
  return opened;
}
