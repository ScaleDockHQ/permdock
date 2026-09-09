import type { ApprovalStore } from '../approvals/types.ts';
import type { Decision } from '../core/decision.ts';
import type {
  DecisionSink,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { Actor, Principal } from '../core/subject.ts';
import type { WebBotAuthOptions } from './web-bot-auth.ts';

import { compact } from '../core/compact.ts';
import { createPermDock as createCorePermDock } from '../core/permdock.ts';
import { listPermissions } from '../core/permissions.ts';
import { isActor } from '../core/subject.ts';
import {
  applyApprovalResume,
  createEvaluationsHandler,
} from './evaluations.ts';
import { problemFromDecision, problemResponse } from './problem.ts';
import { InvalidSignatureError, verifyWebBotAuth } from './web-bot-auth.ts';

export type ServerPermDockOptions<TUser = unknown> = {
  readonly subject: (request: Request) => TUser | Promise<TUser>;
  readonly actor?: (request: Request) => unknown;
  readonly webBotAuth?: WebBotAuthOptions;
  readonly tenant?:
    | string
    | ((request: Request) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly problem?: { readonly base?: string };
};

export type Guard<T = unknown> =
  | {
      readonly ok: true;
      readonly permdock: PermDock;
      readonly decision: Extract<Decision, { readonly outcome: 'granted' }>;
      readonly data: T;
    }
  | { readonly ok: false; readonly response: Response };

export type OpenApiHooks = {
  readonly security: (permission: Permission) => {
    readonly security: readonly Record<string, readonly string[]>[];
    readonly 'x-permdock-permissions': readonly string[];
  };
  readonly securitySchemes: () => Readonly<Record<string, unknown>>;
};

export type ServerPermDock = {
  readonly permdock: (request: Request) => Promise<PermDock>;
  readonly protect: <T = unknown>(
    permission: Permission,
    loadData?: (
      request: Request,
    ) => T | null | undefined | Promise<T | null | undefined>,
  ) => (request: Request) => Promise<Guard<T>>;
  readonly problem: (
    decision: Decision,
    init?: { readonly permission?: Permission; readonly instance?: string },
  ) => Response;
  readonly openapi: OpenApiHooks;
  readonly handler: () => ReturnType<typeof createEvaluationsHandler>;
};

async function resolveActor(
  request: Request,
  options: ServerPermDockOptions,
): Promise<Actor | undefined> {
  const verified = await verifyWebBotAuth(
    request,
    options.webBotAuth,
    options.problem?.base,
  );
  if (verified !== undefined) {
    return verified;
  }
  if (options.actor === undefined) {
    return undefined;
  }
  try {
    const resolved = await options.actor(request);
    return isActor(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

async function resolveTenant(
  tenant: ServerPermDockOptions['tenant'],
  request: Request,
): Promise<string | undefined> {
  if (tenant === undefined || typeof tenant === 'string') {
    return tenant;
  }
  try {
    return await tenant(request);
  } catch {
    return undefined;
  }
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: ServerPermDockOptions<TUser> & {
    readonly wrap?: (dock: PermDock) => PermDock;
  },
): ServerPermDock {
  const cache = new WeakMap<Request, Promise<PermDock>>();

  const permdock = (request: Request): Promise<PermDock> => {
    const hit = cache.get(request);
    if (hit !== undefined) {
      return hit;
    }
    const built = (async (): Promise<PermDock> => {
      const actor = await resolveActor(request, options);
      let user: TUser | null = null;
      try {
        user = await options.subject(request);
      } catch {
        user = null;
      }
      const tenant = await resolveTenant(options.tenant, request);
      const dock = await createCorePermDock(
        policy,
        user,
        compact({
          tenant,
          memberships: options.memberships,
          customRoles: options.customRoles,
          sink: options.sink,
          actor,
        }),
      );
      return options.wrap === undefined ? dock : options.wrap(dock);
    })();
    cache.set(request, built);
    return built;
  };

  const protect =
    <T = unknown>(
      permission: Permission,
      loadData?: (
        request: Request,
      ) => T | null | undefined | Promise<T | null | undefined>,
    ) =>
    async (request: Request): Promise<Guard<T>> => {
      let instance: PermDock;
      try {
        instance = await permdock(request);
      } catch (error) {
        if (error instanceof InvalidSignatureError) {
          return { ok: false, response: error.response };
        }
        throw error;
      }
      let data: T | undefined;
      if (loadData !== undefined) {
        const loaded = await loadData(request);
        if (loaded === null || loaded === undefined) {
          return {
            ok: false,
            response: new Response(null, { status: 404 }),
          };
        }
        data = loaded;
      }
      const raw = (
        instance.decide as (
          next: Permission,
          row?: unknown,
          decideOptions?: {
            readonly source: 'adapter';
            readonly adapter: string;
          },
        ) => Decision
      )(
        permission,
        data,
        compact({ source: 'adapter' as const, adapter: 'server' }),
      );
      const decision = await applyApprovalResume(
        raw,
        permission,
        instance,
        options.store,
        request,
        compact({
          type: permission.resource,
          id:
            data !== null &&
            typeof data === 'object' &&
            'id' in data &&
            (typeof (data as { readonly id?: unknown }).id === 'string' ||
              typeof (data as { readonly id?: unknown }).id === 'number')
              ? String((data as { readonly id: string | number }).id)
              : undefined,
        }),
        'server',
      );
      if (decision.outcome === 'granted') {
        return {
          ok: true,
          permdock: instance,
          decision,
          data: data as T,
        };
      }
      return {
        ok: false,
        response: problemFromDecision(
          decision,
          permission,
          instance.subject,
          compact({ base: options.problem?.base }),
        ),
      };
    };

  const problem = (
    decision: Decision,
    init?: { readonly permission?: Permission; readonly instance?: string },
  ): Response => {
    if (init?.permission !== undefined) {
      return problemFromDecision(
        decision,
        init.permission,
        { principal: null, context: {} },
        compact({
          instance: init.instance,
          base: options.problem?.base,
        }),
      );
    }
    return problemResponse({
      type: `${options.problem?.base ?? 'https://permdock.dev/problems'}/denied`,
      title: 'Permission denied',
      status: 403,
      detail: decision.outcome,
    });
  };

  const openapi: OpenApiHooks = {
    security: (permission: Permission) => ({
      security: [{ oauth2: [permission.scope] }],
      'x-permdock-permissions': [permission.key],
    }),
    securitySchemes: () => {
      const scopes: Record<string, string> = {};
      for (const leaf of listPermissions(policy.permissions)) {
        scopes[leaf.scope] = leaf.meta.title ?? leaf.key;
      }
      return {
        oauth2: {
          type: 'oauth2',
          flows: {},
          scopes,
        },
      };
    },
  };

  const handler = (): ReturnType<typeof createEvaluationsHandler> =>
    createEvaluationsHandler(
      compact({
        policy,
        resolve: permdock,
        store: options.store,
        adapter: 'server',
      }),
    );

  return { permdock, protect, problem, openapi, handler };
}
