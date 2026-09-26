import type {
  ArgumentsHost,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  Type,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';

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
} from '@nestjs/common';
import { APP_FILTER, Reflector } from '@nestjs/core';

import type { ApprovalStore } from '../approvals/types.ts';
import type {
  DecisionSink,
  LimitStore,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { RevocationFeed } from '../core/revocations.ts';
import type { Principal } from '../core/subject.ts';
import type { OtelOptions } from '../otel/types.ts';
import type { PdpFactory } from '../pdp/types.ts';
import type { Connection, ConnectionOptions } from '../server/connection.ts';
import type {
  OpenApiHooks,
  ProtectOptions,
  TenantOption,
  TenantScope,
} from '../server/create.ts';
import type { WebBotAuthOptions } from '../server/web-bot-auth.ts';

import { compact } from '../core/compact.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
} from '../core/errors.ts';
import { applyOtel } from '../otel/instrument.ts';
import { createKernel, tenantScope } from '../server/create.ts';
import { mapPermDockError } from '../server/map-error.ts';
import { POLICY_VIOLATION, onRevoked } from '../server/stream.ts';
import { InvalidSignatureError } from '../server/web-bot-auth.ts';
import { sendNestResponse, toRequest, type NestHttpRequest } from './http.ts';

const PROTECT_KEY = 'permdock:protect';

export type NestRequest = NestHttpRequest & {
  readonly params?: Readonly<Record<string, string>>;
  permdock?: PermDock;
  permdockData?: unknown;
};

export type NestPermDockOptions<TUser = unknown> = {
  readonly subject: (req: NestRequest) => TUser | Promise<TUser>;
  readonly tenant?: TenantOption<NestRequest>;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  /** `createPermDock` from `permdock/pdp`; `protect` then decides delegated permissions remotely. */
  readonly pdp?: PdpFactory;
  /** Accepted for adapter parity; not read by this adapter. */
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
  readonly webBotAuth?: WebBotAuthOptions;
  /**
   * Maps a `ws`, `rpc` or `graphql` context to the request its subject comes
   * from. Without it, a protected handler outside HTTP is denied.
   */
  readonly request?: (context: ExecutionContext) => NestRequest | undefined;
  /** Ends or revalidates open gateway connections (ADR 0052). */
  readonly revocations?: RevocationFeed;
};

/** A gateway client: Socket.IO (`emit`, `disconnect`) or `ws` (`close`). */
export type NestSocket = {
  emit?(event: string, payload: unknown): unknown;
  disconnect?(close?: boolean): unknown;
  close?(code?: number, reason?: string): unknown;
};

export type NestProtect = (
  permission: Permission,
  loadData?: (req: NestRequest) => unknown,
  protectOptions?: ProtectOptions,
) => ClassDecorator & MethodDecorator;

export type NestHandlerOptions = {
  /** Controller path; may hold route params such as `:org`. Default `api/permdock`. */
  readonly path?: string;
};

export type NestPermDock = {
  readonly PermDockModule: Type<unknown>;
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
  readonly permission: Permission;
  readonly loadData?: (req: NestRequest) => unknown;
  readonly options?: ProtectOptions;
};

type ReflectMeta = {
  getMetadata(key: string, target: object): unknown;
  defineMetadata(key: string, value: unknown, target: object): void;
};

class PermDockHttpError extends Error {
  public override readonly name = 'PermDockHttpError' as const;
  public readonly response: Response;

  public constructor(response: Response) {
    super('permdock denied');
    this.response = response;
  }
}

function reflectMeta(): ReflectMeta {
  const ref = Reflect as unknown as ReflectMeta;
  if (
    typeof ref.getMetadata !== 'function' ||
    typeof ref.defineMetadata !== 'function'
  ) {
    throw new TypeError('reflect-metadata is required for permdock/nest');
  }
  return ref;
}

function applyMethod(
  cls: new () => unknown,
  key: string,
  decorator: MethodDecorator,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, key);
  if (descriptor === undefined) {
    throw new TypeError(`missing ${key} handler`);
  }
  decorator(cls.prototype, key, descriptor);
}

function applyParameter(
  cls: new () => unknown,
  key: string,
  index: number,
  decorator: ParameterDecorator,
): void {
  decorator(cls.prototype, key, index);
}

function hasEmit(
  value: unknown,
): value is { emit(event: string, payload: unknown): unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly emit?: unknown }).emit === 'function'
  );
}

function rulesOf(target: object): readonly ProtectRule[] {
  const found = reflectMeta().getMetadata(PROTECT_KEY, target);
  if (!Array.isArray(found)) {
    return [];
  }
  return found as ProtectRule[];
}

const Protect: NestProtect = (permission, loadData, protectOptions) => {
  const rule = compact<ProtectRule>({
    permission,
    loadData,
    options: protectOptions,
  });
  return ((
    target: object,
    _propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    const store: unknown = descriptor === undefined ? target : descriptor.value;
    if (
      typeof store !== 'function' &&
      (typeof store !== 'object' || store === null)
    ) {
      throw new TypeError('Protect requires a class or method');
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
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: globalThis.Request) => {
        const req = contexts.get(request);
        return req === undefined ? null : options.subject(req);
      },
      memberships: options.memberships,
      customRoles: options.customRoles,
      store: options.store,
      sink: options.sink,
      limits: options.limits,
      pdp: options.pdp,
      webBotAuth: options.webBotAuth,
      revocations: options.revocations,
      adapter: 'nest',
      wrap: (dock: PermDock) => applyOtel(dock, options.otel),
    }),
  );

  const scopeOf = (req: NestRequest): Promise<TenantScope> =>
    tenantScope(options.tenant, req);

  const applyProtect = async (
    remaining: readonly ProtectRule[],
    req: NestRequest,
    request: globalThis.Request,
    scope: TenantScope,
  ): Promise<void> => {
    const [rule, ...rest] = remaining;
    if (rule === undefined) {
      return;
    }
    const loader = rule.loadData;
    const guard = await kernel.protect(
      rule.permission,
      loader === undefined ? undefined : (): unknown => loader(req),
      rule.options,
    )(request, scope);
    if (!guard.ok) {
      throw new PermDockHttpError(guard.response);
    }
    req.permdock = guard.permdock;
    req.permdockData = guard.data;
    await applyProtect(rest, req, request, scope);
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
        client.emit?.('permdock:error', problem);
        if (typeof client.disconnect === 'function') {
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

  /** Decides each rule for a gateway message against the client's connection. */
  const checkMessage = async (
    rules: readonly ProtectRule[],
    conn: Connection,
    req: NestRequest | undefined,
  ): Promise<void> => {
    for (const rule of rules) {
      const loader = rule.loadData;
      let data: unknown;
      if (loader !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- rules apply in order
        data = req === undefined ? undefined : await loader(req);
        if (data === null || data === undefined) {
          throw new PermDockHttpError(new Response(null, { status: 404 }));
        }
      }
      const decision = conn.check(
        rule.permission,
        data,
        rule.options?.trusted === false ? { trusted: false } : undefined,
      );
      if (decision.outcome !== 'granted') {
        throw new PermDockHttpError(
          kernel.problem(decision, { permission: rule.permission }),
        );
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
      if (context.getType() === 'ws' && rules.length > 0) {
        const opened = sockets.get(context.switchToWs().getClient<object>());
        if (opened !== undefined) {
          await checkMessage(rules, await opened, options.request?.(context));
          return true;
        }
      }
      const req =
        context.getType() === 'http'
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
      await applyProtect(rules, req, request, scope);
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
          : mapPermDockError(exception);
      if (problem === undefined) {
        throw new TypeError('unhandled permdock exception');
      }
      if (host.getType() === 'http') {
        await this.send(host.switchToHttp().getResponse<unknown>(), problem);
        return;
      }
      const client: unknown =
        host.getType() === 'ws' ? host.switchToWs().getClient<unknown>() : null;
      if (!hasEmit(client)) {
        throw exception;
      }
      const body = (await problem.json()) as { readonly title?: unknown };
      client.emit('exception', {
        status: 'error',
        message: typeof body.title === 'string' ? body.title : 'Forbidden',
        problem: body,
      });
    }
  }
  Catch(
    PermDockHttpError,
    InvalidSignatureError,
    PermDockDeniedError,
    PermDockApprovalRequiredError,
    PermDockValidationError,
  )(PermDockExceptionFilter);
  Injectable()(PermDockExceptionFilter);

  class PermDockRoot {
    public static readonly adapter = 'nest' as const;
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
      if (ctx.getType() !== 'http') {
        return undefined;
      }
      return ctx.switchToHttp().getRequest<NestRequest>().permdock;
    },
  );

  const InjectPermDock = (): ParameterDecorator => injectPermDock();

  const permdockHandler = (
    handlerOptions: NestHandlerOptions = {},
  ): Type<unknown> => {
    const { POST, GET } = kernel.handler((request) => {
      const req = contexts.get(request);
      return req === undefined ? { tenant: undefined } : scopeOf(req);
    });
    class EvaluationsController {
      private readonly send = sendNestResponse;

      public async post(req: NestRequest, res: unknown): Promise<void> {
        const request = toRequest(req);
        contexts.set(request, req);
        await this.send(res, await POST(request));
      }

      public async get(req: NestRequest, res: unknown): Promise<void> {
        await this.send(res, await GET(bind(req)));
      }
    }
    Controller(handlerOptions.path ?? 'api/permdock')(EvaluationsController);
    applyMethod(EvaluationsController, 'post', Post());
    applyMethod(EvaluationsController, 'get', Get());
    applyParameter(EvaluationsController, 'post', 0, Req());
    applyParameter(
      EvaluationsController,
      'post',
      1,
      Res({ passthrough: false }),
    );
    applyParameter(EvaluationsController, 'get', 0, Req());
    applyParameter(
      EvaluationsController,
      'get',
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
