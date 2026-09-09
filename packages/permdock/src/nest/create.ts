import type {
  ArgumentsHost,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  Type,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { OtelOptions } from '../otel/types.ts';
import type { OpenApiHooks } from '../server/create.ts';
import type { WebBotAuthOptions } from '../server/web-bot-auth.ts';

import { compact } from '../core/compact.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
} from '../core/errors.ts';
import { applyOtel } from '../otel/instrument.ts';
import { createPermDock as createKernel } from '../server/create.ts';
import { problemResponse } from '../server/problem.ts';
import { InvalidSignatureError } from '../server/web-bot-auth.ts';
import {
  isServerResponse,
  sendResponse,
  toRequest,
  type NestHttpRequest,
} from './http.ts';

const PROTECT_KEY = 'permdock:protect';

export type NestRequest = NestHttpRequest & {
  readonly params?: Readonly<Record<string, string>>;
  permdock?: PermDock;
  permdockData?: unknown;
};

export type NestPermDockOptions = {
  readonly subject: (req: NestRequest) => unknown;
  readonly tenant?:
    | string
    | ((req: NestRequest) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
  readonly webBotAuth?: WebBotAuthOptions;
};

export type NestProtect = (
  permission: Permission,
  loadData?: (req: NestRequest) => unknown,
) => ClassDecorator & MethodDecorator;

export type NestPermDock = {
  readonly PermDockModule: Type<unknown>;
  readonly PermDockGuard: Type<CanActivate>;
  readonly Protect: NestProtect;
  readonly InjectPermDock: () => ParameterDecorator;
  readonly PermDockExceptionFilter: Type<ExceptionFilter>;
  readonly permdockHandler: () => Type<unknown>;
  readonly openapi: OpenApiHooks;
};

type ProtectRule = {
  readonly permission: Permission;
  readonly loadData?: (req: NestRequest) => unknown;
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

function rulesOf(target: object): readonly ProtectRule[] {
  const found = reflectMeta().getMetadata(PROTECT_KEY, target);
  if (!Array.isArray(found)) {
    return [];
  }
  return found as ProtectRule[];
}

export function createPermDock(
  policy: Policy,
  options: NestPermDockOptions,
): NestPermDock {
  const contexts = new WeakMap<globalThis.Request, NestRequest>();
  const bound = new WeakMap<IncomingMessage, globalThis.Request>();
  const tenantOption = options.tenant;
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: globalThis.Request) => {
        const req = contexts.get(request);
        return req === undefined ? null : options.subject(req);
      },
      tenant:
        typeof tenantOption === 'function'
          ? (
              request: globalThis.Request,
            ): string | undefined | Promise<string | undefined> => {
              const req = contexts.get(request);
              return req === undefined ? undefined : tenantOption(req);
            }
          : tenantOption,
      memberships: options.memberships,
      customRoles: options.customRoles,
      store: options.store,
      sink: options.sink,
      snapshots: options.snapshots,
      webBotAuth: options.webBotAuth,
      wrap: (dock: PermDock) => applyOtel(dock, options.otel),
    }),
  );

  const applyProtect = async (
    remaining: readonly ProtectRule[],
    req: NestRequest,
    request: globalThis.Request,
  ): Promise<void> => {
    const [rule, ...rest] = remaining;
    if (rule === undefined) {
      return;
    }
    const loader = rule.loadData;
    const guard = await kernel.protect(
      rule.permission,
      loader === undefined ? undefined : (): unknown => loader(req),
    )(request);
    if (!guard.ok) {
      throw new PermDockHttpError(guard.response);
    }
    req.permdock = guard.permdock;
    req.permdockData = guard.data;
    await applyProtect(rest, req, request);
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

  class PermDockGuard implements CanActivate {
    private readonly reflector: Reflector;

    public constructor(reflector: Reflector) {
      this.reflector = reflector;
    }

    public async canActivate(context: ExecutionContext): Promise<boolean> {
      if (context.getType() !== 'http') {
        return true;
      }
      const req = context.switchToHttp().getRequest<NestRequest>();
      const request = bind(req);
      const instance = await kernel.permdock(request);
      req.permdock = instance;
      const fromClass = this.reflector.get<ProtectRule[]>(
        PROTECT_KEY,
        context.getClass(),
      );
      const fromHandler = this.reflector.get<ProtectRule[]>(
        PROTECT_KEY,
        context.getHandler(),
      );
      const rules = [
        ...(Array.isArray(fromClass) ? fromClass : rulesOf(context.getClass())),
        ...(Array.isArray(fromHandler)
          ? fromHandler
          : rulesOf(context.getHandler())),
      ];
      await applyProtect(rules, req, request);
      return true;
    }
  }
  Inject(Reflector)(PermDockGuard, undefined, 0);
  Injectable()(PermDockGuard);

  class PermDockExceptionFilter implements ExceptionFilter {
    private readonly send = sendResponse;

    public async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
      const response = host.switchToHttp().getResponse<unknown>();
      if (!isServerResponse(response)) {
        throw new TypeError('unsupported Nest response');
      }
      if (exception instanceof InvalidSignatureError) {
        await this.send(response, exception.response);
        return;
      }
      if (exception instanceof PermDockHttpError) {
        await this.send(response, exception.response);
        return;
      }
      if (exception instanceof PermDockDeniedError) {
        await this.send(
          response,
          problemResponse(
            exception.toProblemDetails(),
            undefined,
            exception.decision,
          ),
        );
        return;
      }
      if (exception instanceof PermDockApprovalRequiredError) {
        await this.send(
          response,
          problemResponse(
            exception.toProblemDetails(),
            undefined,
            exception.decision,
          ),
        );
        return;
      }
      if (exception instanceof PermDockValidationError) {
        await this.send(
          response,
          problemResponse(exception.toProblemDetails()),
        );
        return;
      }
      throw new TypeError('unhandled permdock exception');
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

  const Protect: NestProtect = (permission, loadData) => {
    const rule = compact<ProtectRule>({ permission, loadData });
    return ((
      target: object,
      _propertyKey?: string | symbol,
      descriptor?: PropertyDescriptor,
    ): void => {
      const store: unknown =
        descriptor === undefined ? target : descriptor.value;
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

  const injectPermDock = createParamDecorator(
    (_data: unknown, ctx: ExecutionContext): PermDock | undefined => {
      if (ctx.getType() !== 'http') {
        return undefined;
      }
      return ctx.switchToHttp().getRequest<NestRequest>().permdock;
    },
  );

  const InjectPermDock = (): ParameterDecorator => injectPermDock();

  const permdockHandler = (): Type<unknown> => {
    const { POST, GET } = kernel.handler();
    class EvaluationsController {
      private readonly send = sendResponse;

      public async post(req: NestRequest, res: ServerResponse): Promise<void> {
        await this.send(res, await POST(bind(req)));
      }

      public async get(req: NestRequest, res: ServerResponse): Promise<void> {
        await this.send(res, await GET(bind(req)));
      }
    }
    Controller('api/permdock')(EvaluationsController);
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
    openapi: kernel.openapi,
  };
}
