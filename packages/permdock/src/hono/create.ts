import { Hono, type Context, type MiddlewareHandler, type Next } from 'hono';

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

import { compact } from '../core/compact.ts';
import { applyOtel } from '../otel/instrument.ts';
import { createPermDock as createKernel } from '../server/create.ts';

export type HonoPermDockOptions = {
  readonly subject: (c: Context) => unknown;
  readonly tenant?:
    | string
    | ((c: Context) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
};

export type HonoPermDock = {
  readonly permdock: () => MiddlewareHandler;
  readonly protect: (
    permission: Permission,
    loadData?: (c: Context) => unknown,
  ) => MiddlewareHandler;
  readonly permdockHandler: () => Hono;
  readonly openapi: OpenApiHooks;
};

export function createPermDock(
  policy: Policy,
  options: HonoPermDockOptions,
): HonoPermDock {
  const contexts = new WeakMap<Request, Context>();
  const tenantOption = options.tenant;
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: Request) => {
        const c = contexts.get(request);
        return c === undefined ? null : options.subject(c);
      },
      tenant:
        typeof tenantOption === 'function'
          ? (
              request: Request,
            ): string | undefined | Promise<string | undefined> => {
              const c = contexts.get(request);
              return c === undefined ? undefined : tenantOption(c);
            }
          : tenantOption,
      memberships: options.memberships,
      customRoles: options.customRoles,
      store: options.store,
      sink: options.sink,
      snapshots: options.snapshots,
      wrap: (dock: PermDock) => applyOtel(dock, options.otel),
    }),
  );

  const bind = (c: Context): Request => {
    const raw = c.req.raw;
    contexts.set(raw, c);
    return raw;
  };

  const permdock = (): MiddlewareHandler => async (c, next: Next) => {
    c.set('permdock', await kernel.permdock(bind(c)));
    await next();
  };

  const protect =
    (
      permission: Permission,
      loadData?: (c: Context) => unknown,
    ): MiddlewareHandler =>
    async (c, next: Next): Promise<Response | undefined> => {
      const guard = await kernel.protect(
        permission,
        loadData === undefined ? undefined : (): unknown => loadData(c),
      )(bind(c));
      if (!guard.ok) {
        return guard.response;
      }
      c.set('permdock', guard.permdock);
      c.set('permdockData', guard.data);
      await next();
      return undefined;
    };

  const permdockHandler = (): Hono => {
    const { POST, GET } = kernel.handler();
    const app = new Hono();
    app.post('/', (c) => POST(bind(c)));
    app.get('/', (c) => GET(bind(c)));
    return app;
  };

  return { permdock, protect, permdockHandler, openapi: kernel.openapi };
}
