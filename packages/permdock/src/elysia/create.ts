import { Elysia } from 'elysia';

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
import type { OpenApiHooks } from '../server/create.ts';

import { compact } from '../core/compact.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
} from '../core/errors.ts';
import { createPermDock as createKernel } from '../server/create.ts';
import { problemResponse } from '../server/problem.ts';

export type ElysiaCtx = {
  readonly request: Request;
  readonly body?: unknown;
  readonly params?: Readonly<Record<string, string | undefined>>;
};

export type ElysiaPermDockOptions = {
  readonly subject: (ctx: ElysiaCtx) => unknown;
  readonly tenant?:
    | string
    | ((ctx: ElysiaCtx) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
};

export type ElysiaContext = ElysiaCtx & {
  permdock: PermDock;
  permdockData?: unknown;
};

export type ElysiaProtect = (
  permission: Permission,
  loadData?: (ctx: ElysiaCtx) => unknown,
) => (ctx: ElysiaCtx) => Promise<Response | undefined>;

export type ElysiaPermDock = {
  readonly permdock: () => Elysia;
  readonly protect: ElysiaProtect;
  readonly permdockHandler: () => Elysia;
  readonly openapi: OpenApiHooks;
};

export function createPermDock(
  policy: Policy,
  options: ElysiaPermDockOptions,
): ElysiaPermDock {
  const contexts = new WeakMap<Request, ElysiaCtx>();
  const bound = new WeakMap<ElysiaCtx, Request>();
  const tenantOption = options.tenant;
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: Request) => {
        const ctx = contexts.get(request);
        return ctx === undefined ? null : options.subject(ctx);
      },
      tenant:
        typeof tenantOption === 'function'
          ? (
              request: Request,
            ): string | undefined | Promise<string | undefined> => {
              const ctx = contexts.get(request);
              return ctx === undefined ? undefined : tenantOption(ctx);
            }
          : tenantOption,
      memberships: options.memberships,
      customRoles: options.customRoles,
      store: options.store,
      sink: options.sink,
      snapshots: options.snapshots,
    }),
  );

  const bind = (ctx: ElysiaCtx): Request => {
    const hit = bound.get(ctx);
    if (hit !== undefined) {
      return hit;
    }
    const next = toRequest(ctx);
    bound.set(ctx, next);
    contexts.set(next, ctx);
    return next;
  };

  const decorate = (
    ctx: ElysiaCtx,
    instance: PermDock,
    data?: unknown,
  ): void => {
    const scoped = ctx as ElysiaContext;
    scoped.permdock = instance;
    if (data !== undefined) {
      scoped.permdockData = data;
    }
  };

  const permdock = (): Elysia =>
    new Elysia({ name: 'permdock' })
      .derive({ as: 'global' }, async (ctx) => {
        const instance = await kernel.permdock(bind(ctx));
        decorate(ctx, instance);
        return { permdock: instance };
      })
      .onError(({ error }) => {
        if (error instanceof PermDockDeniedError) {
          return problemResponse(
            error.toProblemDetails(),
            undefined,
            error.decision,
          );
        }
        if (error instanceof PermDockApprovalRequiredError) {
          return problemResponse(
            error.toProblemDetails(),
            undefined,
            error.decision,
          );
        }
        if (error instanceof PermDockValidationError) {
          return problemResponse(error.toProblemDetails());
        }
        return undefined;
      }) as unknown as Elysia;

  const protect: ElysiaProtect = (permission, loadData) => async (ctx) => {
    const guard = await kernel.protect(
      permission,
      loadData === undefined ? undefined : (): unknown => loadData(ctx),
    )(bind(ctx));
    if (!guard.ok) {
      return guard.response;
    }
    decorate(ctx, guard.permdock, guard.data);
    return undefined;
  };

  const permdockHandler = (): Elysia => {
    const { POST, GET } = kernel.handler();
    return new Elysia({ name: 'permdock-handler' })
      .post('/', (ctx) => POST(bind(ctx)))
      .get('/', (ctx) => GET(bind(ctx))) as unknown as Elysia;
  };

  return { permdock, protect, permdockHandler, openapi: kernel.openapi };
}

function toRequest(ctx: ElysiaCtx): Request {
  const method = ctx.request.method;
  if (method === 'GET' || method === 'HEAD' || ctx.body === undefined) {
    return ctx.request;
  }
  const headers = new Headers(ctx.request.headers);
  const body =
    typeof ctx.body === 'string' ? ctx.body : JSON.stringify(ctx.body);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Request(ctx.request.url, { method, headers, body });
}
