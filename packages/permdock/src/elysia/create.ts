import { Elysia } from 'elysia';

import type { ApprovalStore } from '../approvals/types.ts';
import type { PolicySource } from '../core/hosted.ts';
import type {
  DecisionSink,
  EntitlementSource,
  LimitStore,
  MembershipSource,
  RelationSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy, PolicyVocabulary } from '../core/policy.ts';
import type { RevocationFeed } from '../core/revocations.ts';
import type { Principal } from '../core/subject.ts';
import type { OtelWrap } from '../otel/types.ts';
import type { PdpFactory } from '../pdp/types.ts';
import type { Connection, ConnectionOptions } from '../server/connection.ts';
import type {
  OpenApiHooks,
  ProtectOptions,
  TenantOption,
  TenantScope,
} from '../server/create.ts';
import type { WebBotAuthVerifier } from '../server/web-bot-auth.ts';

import { compact } from '../core/compact.ts';
import { createKernel, tenantScope } from '../server/create.ts';
import { problemFromError } from '../server/map-error.ts';
import { POLICY_VIOLATION, onRevoked } from '../server/stream.ts';

export type ElysiaCtx = {
  readonly request: Request;
  readonly body?: unknown;
  readonly params?: Readonly<Record<string, string | undefined>>;
};

export type ElysiaPermDockOptions<TUser = unknown> = {
  readonly subject: (ctx: ElysiaCtx) => TUser | Promise<TUser>;
  readonly tenant?: TenantOption<ElysiaCtx>;
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  /** The object graph for relation grants that walk a parent chain; without it they deny. */
  readonly relations?: RelationSource;
  readonly entitlements?: EntitlementSource;
  readonly customRoles?: RoleSource;
  /** Hosted grants, read once per instance; see `PolicySource`. */
  readonly policies?: PolicySource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  /** `createPermDock` from `permdock/pdp`; `protect` then decides delegated permissions remotely. */
  readonly pdp?: PdpFactory;
  /** Accepted for adapter parity; not read by this adapter. */
  readonly snapshots?: SnapshotSource;
  /** `(permdock) => withOtel(permdock, options)` from `permdock/otel`. */
  readonly otel?: OtelWrap;
  /** `(request) => verifyWebBotAuth(request, options)`; a verified bot becomes the actor. */
  readonly webBotAuth?: WebBotAuthVerifier;
  /** Ends or revalidates open sockets. */
  readonly revocations?: RevocationFeed;
};

/** The `ws` Elysia passes to `.ws` handlers; `data` is the upgrade context. */
export type ElysiaSocket = {
  readonly data: ElysiaCtx;
  close(code?: number, reason?: string): unknown;
};

export type ElysiaContext<V extends PolicyVocabulary = PolicyVocabulary> =
  ElysiaCtx & {
    permdock: PermDock<V>;
    permdockData?: unknown;
  };

export type ElysiaProtect = (
  permission: Permission,
  loadData?: (ctx: ElysiaCtx) => unknown,
  protectOptions?: ProtectOptions,
) => (ctx: ElysiaCtx) => Promise<Response | undefined>;

/** The `permdock()` plugin: its global derive types `permdock` in every later handler. */
export type ElysiaPermDockPlugin<
  V extends PolicyVocabulary = PolicyVocabulary,
> = Elysia<
  '',
  /* oxlint-disable typescript/no-generated-empty-object-type -- Elysia's own empty singleton slots */
  {
    decorator: Record<never, never>;
    store: Record<never, never>;
    derive: { readonly permdock: PermDock<V> };
    resolve: Record<never, never>;
  }
  /* oxlint-enable typescript/no-generated-empty-object-type */
>;

export type ElysiaPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly permdock: () => ElysiaPermDockPlugin<V>;
  readonly protect: ElysiaProtect;
  /**
   * One connection per socket: the same promise for every handler
   * of that socket; closes it with `1008` when the connection aborts.
   */
  readonly connection: (
    ws: ElysiaSocket,
    connectionOptions?: ConnectionOptions,
  ) => Promise<Connection>;
  readonly permdockHandler: () => Elysia;
  readonly openapi: OpenApiHooks;
};

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: ElysiaPermDockOptions<TUser>,
): ElysiaPermDock<V> {
  const contexts = new WeakMap<Request, ElysiaCtx>();
  const bound = new WeakMap<ElysiaCtx, Request>();
  const seed = globalThis.crypto.randomUUID();
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: Request) => {
        const ctx = contexts.get(request);
        return ctx === undefined ? null : options.subject(ctx);
      },
      memberships: options.memberships,
      relations: options.relations,
      entitlements: options.entitlements,
      customRoles: options.customRoles,
      policies: options.policies,
      store: options.store,
      sink: options.sink,
      limits: options.limits,
      pdp: options.pdp,
      webBotAuth: options.webBotAuth,
      revocations: options.revocations,
      adapter: 'elysia',
      wrap: options.otel,
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

  const scopeOf = (ctx: ElysiaCtx): Promise<TenantScope> =>
    tenantScope(options.tenant, ctx);

  const decorate = (
    ctx: ElysiaCtx,
    instance: PermDock<V>,
    data?: unknown,
  ): void => {
    // SAFETY: ElysiaContext is the request context plus the permdock fields assigned here.
    const scoped = ctx as ElysiaContext<V>;
    scoped.permdock = instance;
    if (data !== undefined) {
      scoped.permdockData = data;
    }
  };

  // SAFETY: the chain returns an Elysia instance; its generics are narrowed to the global permdock derive.
  const permdock = (): ElysiaPermDockPlugin<V> =>
    new Elysia({ name: 'permdock', seed })
      .derive({ as: 'global' }, async (ctx) => {
        const instance = await kernel.permdock(bind(ctx), await scopeOf(ctx));
        decorate(ctx, instance);
        return { permdock: instance };
      })
      .onError({ as: 'global' }, ({ error }) =>
        problemFromError(error),
      ) as unknown as ElysiaPermDockPlugin<V>;

  const protect: ElysiaProtect =
    (permission, loadData, protectOptions) => async (ctx) => {
      const guard = await kernel.protect(
        permission,
        loadData === undefined ? undefined : (): unknown => loadData(ctx),
        protectOptions,
      )(bind(ctx), await scopeOf(ctx));
      if (!guard.ok) {
        return guard.response;
      }
      decorate(ctx, guard.permdock, guard.data);
      return undefined;
    };

  const sockets = new WeakMap<object, Promise<Connection>>();

  const connection = (
    ws: ElysiaSocket,
    connectionOptions?: ConnectionOptions,
  ): Promise<Connection> => {
    const hit = sockets.get(ws.data);
    if (hit !== undefined) {
      return hit;
    }
    const opened = (async (): Promise<Connection> => {
      const conn = await kernel.connection(
        bind(ws.data),
        connectionOptions,
        await scopeOf(ws.data),
      );
      onRevoked(conn, (problem) => {
        ws.close(POLICY_VIOLATION, problem.type);
      });
      return conn;
    })();
    sockets.set(ws.data, opened);
    return opened;
  };

  const permdockHandler = (): Elysia => {
    const { POST, GET } = kernel.permdockHandler((request) => {
      const ctx = contexts.get(request);
      return ctx === undefined ? { tenant: undefined } : scopeOf(ctx);
    });
    // SAFETY: the chain returns an Elysia instance; only its accumulated generics are dropped.
    return new Elysia({ name: 'permdock-handler', seed })
      .post('/', (ctx) => POST(bind(ctx)))
      .get('/', (ctx) => GET(bind(ctx))) as unknown as Elysia;
  };

  return {
    permdock,
    protect,
    connection,
    permdockHandler,
    openapi: kernel.openapi,
  };
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
