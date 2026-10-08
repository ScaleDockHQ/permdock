import type {
  ArgumentsHost,
  CanActivate,
  DynamicModule,
  ExceptionFilter,
  ExecutionContext,
  Type,
} from "@nestjs/common";
import type { IncomingMessage } from "node:http";

import {
  Catch,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Post,
  Req,
  Res,
  createParamDecorator,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD, Reflector } from "@nestjs/core";

import type { ApprovalStore } from "../approvals/types.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { SnapshotSource } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy } from "../core/policy.ts";
import type { RevocationFeed } from "../core/revocations.ts";
import type { Principal } from "../core/subject.ts";
import type { OtelWrap } from "../otel/types.ts";
import type { PdpFactory } from "../pdp/types.ts";
import type { Connection, ConnectionOptions } from "../server/connection.ts";
import type {
  OpenApiHooks,
  ProtectOptions,
  TenantOption,
  TenantScope,
} from "../server/create.ts";
import type { WebBotAuthVerifier } from "../server/web-bot-auth.ts";

import { compact } from "../core/compact.ts";
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockRevokedError,
  PermDockValidationError,
} from "../core/errors.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { createServerKernel, tenantScope } from "../server/create.ts";
import { problemFromError } from "../server/map-error.ts";
import { POLICY_VIOLATION, onRevoked } from "../server/stream.ts";
import { InvalidSignatureError } from "../server/web-bot-auth.ts";
import { decorateMethod } from "./decorate.ts";
import { sendNestResponse, toRequest, type NestHttpRequest } from "./http.ts";

const PROTECT_KEY = "permdock:protect";

export type NestRequest = NestHttpRequest & {
  readonly params?: Readonly<Record<string, string>>;
  permdock?: PermDock;
  permdockData?: unknown;
};

export type NestPermDockOptions<TUser = unknown> = InstanceOptions & {
  readonly subject: (req: NestRequest) => TUser | Promise<TUser>;
  /** The agent or service acting for the subject; anything but an `Actor` is ignored. */
  readonly actor?: (req: NestRequest) => unknown;
  readonly tenant?: TenantOption<NestRequest>;
  readonly store?: ApprovalStore;
  /** `createPermDock` from `permdock/pdp`; `protect` then decides delegated permissions remotely. */
  readonly pdp?: PdpFactory;
  /** @deprecated Not read by any adapter. */
  readonly snapshots?: SnapshotSource;
  /** `(permdock) => withOtel(permdock, options)` from `permdock/otel`. */
  readonly otel?: OtelWrap;
  /** `(request) => verifyWebBotAuth(request, options)`; a verified bot becomes the actor. */
  readonly webBotAuth?: WebBotAuthVerifier;
  /**
   * Maps a `ws`, `rpc` or `graphql` context to the request its subject comes
   * from. Without it, a protected handler outside HTTP is denied.
   */
  readonly request?: (context: ExecutionContext) => NestRequest | undefined;
  /** Ends or revalidates open gateway connections. */
  readonly revocations?: RevocationFeed;
};

/** A gateway client: Socket.IO (`emit`, `disconnect`) or `ws` (`close`). */
export type NestSocket = {
  emit?(event: string, payload: unknown): unknown;
  disconnect?(close?: boolean): unknown;
  close?(code?: number, reason?: string): unknown;
};

/** `Protect(null, loadData?, { oauthScopes })` needs a principal and one of the OAuth scopes, but no permission. */
export type NestProtect = (
  permission: Permission | null,
  loadData?: (req: NestRequest) => unknown,
  protectOptions?: ProtectOptions,
) => ClassDecorator & MethodDecorator;

export type NestHandlerOptions = {
  /** Controller path; may hold route params such as `:org`. Default `api/permdock`. */
  readonly path?: string;
};

export type PermDockModuleOptions = {
  /** `"global"` registers `PermDockGuard` as `APP_GUARD`, so every `Protect` rule runs without `UseGuards`. */
  readonly guard?: "global";
};

export type NestPermDock = {
  readonly PermDockModule: Type<unknown> & {
    readonly forRoot: (options?: PermDockModuleOptions) => DynamicModule;
  };
  readonly PermDockGuard: Type<CanActivate>;
  readonly Protect: NestProtect;
  readonly InjectPermDock: () => ParameterDecorator;
  readonly PermDockExceptionFilter: Type<ExceptionFilter>;
  readonly permdockHandler: (options?: NestHandlerOptions) => Type<unknown>;
  /**
   * Opens the connection for a gateway client in `handleConnection`, from the
   * handshake request. `Protect` rules on that client's messages then decide
   * against the connection's current instance.
   */
  readonly connection: (
    client: NestSocket,
    req: NestRequest,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  readonly openapi: OpenApiHooks;
};

type ProtectRule = {
  readonly permission: Permission | null;
  readonly loadData?: (req: NestRequest) => unknown;
  readonly options?: ProtectOptions;
};

type ReflectMeta = {
  getMetadata(key: string, target: object): unknown;
  defineMetadata(key: string, value: unknown, target: object): void;
};

class PermDockHttpError extends Error {
  public override readonly name = "PermDockHttpError" as const;
  public readonly response: Response;

  public constructor(response: Response) {
    super("permdock denied");
    this.response = response;
  }
}

function reflectMeta(): ReflectMeta {
  // SAFETY: reflect-metadata adds these methods to Reflect; both are typeof-checked below.
  const ref = Reflect as unknown as ReflectMeta;
  if (
    typeof ref.getMetadata !== "function" ||
    typeof ref.defineMetadata !== "function"
  ) {
    throw new TypeError("reflect-metadata is required for permdock/nest");
  }
  return ref;
}

function applyParameter(
  cls: { readonly prototype: object },
  key: string,
  index: number,
  decorator: ParameterDecorator,
): void {
  decorator(cls.prototype, key, index);
}

function hasEmit(
  value: unknown,
): value is { emit(event: string, payload: unknown): unknown } {
  // SAFETY: checked to be a non-null object first; emit is only typeof-checked.
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly emit?: unknown }).emit === "function"
  );
}

type Loads = (
  loader: ((req: NestRequest) => unknown) | undefined,
) => (() => unknown) | undefined;

/** One call per loader for a request, so class and method rules naming the same loader share its row. */
function loadsFor(req: NestRequest | undefined): Loads {
  const loaded = new Map<(req: NestRequest) => unknown, Promise<unknown>>();
  return (loader) => {
    if (loader === undefined) {
      return undefined;
    }
    return (): Promise<unknown> => {
      if (req === undefined) {
        return Promise.resolve(undefined);
      }
      let hit = loaded.get(loader);
      if (hit === undefined) {
        hit = Promise.resolve(loader(req));
        loaded.set(loader, hit);
      }
      return hit;
    };
  };
}

function rulesOf(target: object): readonly ProtectRule[] {
  const found = reflectMeta().getMetadata(PROTECT_KEY, target);
  if (!Array.isArray(found)) {
    return [];
  }
  // SAFETY: only Protect below defines PROTECT_KEY metadata, always as a ProtectRule array.
  return found as ProtectRule[];
}

const Protect: NestProtect = (permission, loadData, protectOptions) => {
  const rule = compact<ProtectRule>({
    permission,
    loadData,
    options: protectOptions,
  });
  // SAFETY: the function accepts both the class and the method decorator call shapes.
  return ((
    target: object,
    _propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    const store: unknown = descriptor === undefined ? target : descriptor.value;
    if (
      typeof store !== "function" &&
      (typeof store !== "object" || store === null)
    ) {
      throw new TypeError("Protect requires a class or method");
    }
    const existing = rulesOf(store);
    reflectMeta().defineMetadata(PROTECT_KEY, [...existing, rule], store);
  }) as ClassDecorator & MethodDecorator;
};

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: NestPermDockOptions<TUser>,
): NestPermDock {
  const contexts = new WeakMap<globalThis.Request, NestRequest>();
  const bound = new WeakMap<IncomingMessage, globalThis.Request>();
  const kernel = createServerKernel(
    policy,
    compact({
      subject: (request: globalThis.Request) => {
        const req = contexts.get(request);
        return req === undefined ? null : options.subject(req);
      },
      actor:
        options.actor === undefined
          ? undefined
          : (request: globalThis.Request): unknown => {
              const req = contexts.get(request);
              return req === undefined ? undefined : options.actor?.(req);
            },
      ...instanceOptions(options),
      store: options.store,
      pdp: options.pdp,
      webBotAuth: options.webBotAuth,
      revocations: options.revocations,
      adapter: "nest",
      wrap: options.otel,
    }),
  );

  const scopeOf = (req: NestRequest): Promise<TenantScope> =>
    tenantScope(options.tenant, req);

  const applyProtect = async (
    remaining: readonly ProtectRule[],
    req: NestRequest,
    request: globalThis.Request,
    scope: TenantScope,
    load: Loads,
  ): Promise<void> => {
    const [rule, ...rest] = remaining;
    if (rule === undefined) {
      return;
    }
    const guard = await kernel.protect(
      rule.permission,
      load(rule.loadData),
      rule.options,
    )(request, scope);
    if (!guard.ok) {
      throw new PermDockHttpError(guard.response);
    }
    req.permdock = guard.permdock;
    req.permdockData = guard.data;
    await applyProtect(rest, req, request, scope, load);
  };

  const bind = (req: NestRequest): globalThis.Request => {
    const hit = bound.get(req);
    if (hit !== undefined) {
      return hit;
    }
    const request = toRequest(req);
    bound.set(req, request);
    contexts.set(request, req);
    return request;
  };

  const sockets = new WeakMap<object, Promise<Connection>>();

  const connection = (
    client: NestSocket,
    req: NestRequest,
    connectionOptions?: ConnectionOptions,
  ): Promise<Connection> => {
    const hit = sockets.get(client);
    if (hit !== undefined) {
      return hit;
    }
    const opened = (async (): Promise<Connection> => {
      const conn = await kernel.connection(
        bind(req),
        connectionOptions,
        await scopeOf(req),
      );
      onRevoked(conn, (problem) => {
        client.emit?.("permdock:error", problem);
        if (typeof client.disconnect === "function") {
          client.disconnect(true);
        } else {
          client.close?.(POLICY_VIOLATION, problem.type);
        }
      });
      return conn;
    })();
    sockets.set(client, opened);
    return opened;
  };

  /** Decides each rule for a gateway message against the client's connection, as `protect` does for HTTP. */
  const checkMessage = async (
    rules: readonly ProtectRule[],
    conn: Connection,
    req: NestRequest | undefined,
  ): Promise<void> => {
    const request = req === undefined ? undefined : bind(req);
    const load = loadsFor(req);
    for (const rule of rules) {
      if (conn.signal.aborted) {
        throw conn.signal.reason instanceof PermDockRevokedError
          ? conn.signal.reason
          : new PermDockRevokedError({ code: "denied" });
      }
      // oxlint-disable-next-line no-await-in-loop -- rules apply in order
      const guard = await kernel.protectOn(
        conn.permdock,
        rule.permission,
        load(rule.loadData),
        rule.options,
        request,
      );
      if (!guard.ok) {
        throw new PermDockHttpError(guard.response);
      }
    }
  };

  class PermDockGuard implements CanActivate {
    private readonly reflector: Reflector;

    public constructor(reflector: Reflector) {
      this.reflector = reflector;
    }

    public async canActivate(context: ExecutionContext): Promise<boolean> {
      const rules = this.rulesFor(context);
      if (context.getType() === "ws" && rules.length > 0) {
        const opened = sockets.get(context.switchToWs().getClient<object>());
        if (opened !== undefined) {
          await checkMessage(rules, await opened, options.request?.(context));
          return true;
        }
      }
      const req =
        context.getType() === "http"
          ? context.switchToHttp().getRequest<NestRequest>()
          : rules.length === 0
            ? undefined
            : options.request?.(context);
      if (req === undefined) {
        return rules.length === 0;
      }
      const request = bind(req);
      const scope = await scopeOf(req);
      req.permdock = await kernel.permdock(request, scope);
      await applyProtect(rules, req, request, scope, loadsFor(req));
      return true;
    }

    private rulesFor(context: ExecutionContext): readonly ProtectRule[] {
      const fromClass = this.reflector.get<ProtectRule[]>(
        PROTECT_KEY,
        context.getClass(),
      );
      const fromHandler = this.reflector.get<ProtectRule[]>(
        PROTECT_KEY,
        context.getHandler(),
      );
      return [
        ...(Array.isArray(fromClass) ? fromClass : rulesOf(context.getClass())),
        ...(Array.isArray(fromHandler)
          ? fromHandler
          : rulesOf(context.getHandler())),
      ];
    }
  }
  Inject(Reflector)(PermDockGuard, undefined, 0);
  Injectable()(PermDockGuard);

  class PermDockExceptionFilter implements ExceptionFilter {
    private readonly send = sendNestResponse;

    public async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
      const problem =
        exception instanceof PermDockHttpError
          ? exception.response
          : problemFromError(exception, {
              credentials:
                host.getType() === "http" &&
                host.switchToHttp().getRequest<NestRequest>().headers
                  .authorization !== undefined,
            });
      if (problem === undefined) {
        throw new TypeError("unhandled permdock exception");
      }
      if (host.getType() === "http") {
        await this.send(host.switchToHttp().getResponse<unknown>(), problem);
        return;
      }
      const client: unknown =
        host.getType() === "ws" ? host.switchToWs().getClient<unknown>() : null;
      if (!hasEmit(client)) {
        throw exception;
      }
      // SAFETY: problem is a Problem Details JSON object PermDock built; title is typeof-checked below.
      const body = (await problem.json()) as { readonly title?: unknown };
      client.emit("exception", {
        status: "error",
        message: typeof body.title === "string" ? body.title : "Forbidden",
        problem: body,
      });
    }
  }
  Catch(
    PermDockHttpError,
    InvalidSignatureError,
    PermDockDeniedError,
    PermDockApprovalRequiredError,
    PermDockRevokedError,
    PermDockValidationError,
  )(PermDockExceptionFilter);
  Injectable()(PermDockExceptionFilter);

  class PermDockRoot {
    public static readonly adapter = "nest" as const;

    public static forRoot(
      moduleOptions: PermDockModuleOptions = {},
    ): DynamicModule {
      return {
        module: PermDockRoot,
        providers:
          moduleOptions.guard === "global"
            ? [{ provide: APP_GUARD, useExisting: PermDockGuard }]
            : [],
      };
    }
  }
  Module({
    providers: [
      {
        provide: PermDockGuard,
        useFactory: (reflector: Reflector): PermDockGuard =>
          new PermDockGuard(reflector),
        inject: [Reflector],
      },
      {
        provide: PermDockExceptionFilter,
        useFactory: (): PermDockExceptionFilter =>
          new PermDockExceptionFilter(),
      },
      {
        provide: APP_FILTER,
        useExisting: PermDockExceptionFilter,
      },
    ],
    exports: [PermDockGuard, PermDockExceptionFilter],
  })(PermDockRoot);

  const injectPermDock = createParamDecorator(
    (_data: unknown, ctx: ExecutionContext): PermDock | undefined => {
      if (ctx.getType() !== "http") {
        return undefined;
      }
      return ctx.switchToHttp().getRequest<NestRequest>().permdock;
    },
  );

  const InjectPermDock = (): ParameterDecorator => injectPermDock();

  const permdockHandler = (
    handlerOptions: NestHandlerOptions = {},
  ): Type<unknown> => {
    const { POST, GET } = kernel.permdockHandler((request) => {
      const req = contexts.get(request);
      return req === undefined ? { tenant: undefined } : scopeOf(req);
    });
    class EvaluationsController {
      private readonly send = sendNestResponse;

      public async post(req: NestRequest, res: unknown): Promise<void> {
        const request = toRequest(req);
        contexts.set(request, req);
        const previous = bound.get(req);
        if (previous !== undefined) {
          kernel.shareSubject(previous, request);
        }
        await this.send(res, await POST(request));
      }

      public async get(req: NestRequest, res: unknown): Promise<void> {
        await this.send(res, await GET(bind(req)));
      }
    }
    Controller(handlerOptions.path ?? "api/permdock")(EvaluationsController);
    decorateMethod(EvaluationsController, "post", Post());
    decorateMethod(EvaluationsController, "get", Get());
    applyParameter(EvaluationsController, "post", 0, Req());
    applyParameter(
      EvaluationsController,
      "post",
      1,
      Res({ passthrough: false }),
    );
    applyParameter(EvaluationsController, "get", 0, Req());
    applyParameter(
      EvaluationsController,
      "get",
      1,
      Res({ passthrough: false }),
    );
    return EvaluationsController;
  };

  return {
    PermDockModule: PermDockRoot,
    PermDockGuard,
    Protect,
    InjectPermDock,
    PermDockExceptionFilter,
    permdockHandler,
    connection,
    openapi: kernel.openapi,
  };
}
