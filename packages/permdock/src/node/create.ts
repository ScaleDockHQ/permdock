import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApprovalStore } from '../approvals/types.ts';
import type { PolicySource } from '../core/hosted.ts';
import type {
  DecisionSink,
  LimitStore,
  EntitlementSource,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { Principal } from '../core/subject.ts';
import type { OtelOptions } from '../otel/types.ts';
import type { PdpFactory } from '../pdp/types.ts';
import type {
  Guard,
  OpenApiHooks,
  ProtectOptions,
  TenantOption,
  TenantScope,
} from '../server/create.ts';
import type { WebBotAuthOptions } from '../server/web-bot-auth.ts';

import { compact } from '../core/compact.ts';
import { applyOtel } from '../otel/instrument.ts';
import { createKernel, tenantScope } from '../server/create.ts';
import {
  fromResponse,
  sendResponse,
  toRequest,
  type NodeRequest,
} from './http.ts';

export type NodePermDockOptions<TUser = unknown> = {
  readonly subject: (req: NodeRequest) => TUser | Promise<TUser>;
  readonly tenant?: TenantOption<NodeRequest>;
  readonly memberships?: MembershipSource | readonly MembershipSource[];
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
  readonly otel?: OtelOptions;
  readonly webBotAuth?: WebBotAuthOptions;
};

export type NodePermDock = {
  readonly permdock: (req: IncomingMessage) => Promise<PermDock>;
  readonly protect: (
    permission: Permission,
    loadData?: (req: NodeRequest) => unknown,
    protectOptions?: ProtectOptions,
  ) => (req: IncomingMessage) => Promise<Guard>;
  readonly send: typeof sendResponse;
  readonly permdockHandler: () => (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  readonly toRequest: typeof toRequest;
  readonly fromResponse: typeof fromResponse;
  readonly openapi: OpenApiHooks;
};

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: NodePermDockOptions<TUser>,
): NodePermDock {
  const contexts = new WeakMap<globalThis.Request, NodeRequest>();
  const bound = new WeakMap<IncomingMessage, globalThis.Request>();
  const kernel = createKernel(
    policy,
    compact({
      subject: (request: globalThis.Request) => {
        const req = contexts.get(request);
        return req === undefined ? null : options.subject(req);
      },
      memberships: options.memberships,
      entitlements: options.entitlements,
      customRoles: options.customRoles,
      policies: options.policies,
      store: options.store,
      sink: options.sink,
      limits: options.limits,
      pdp: options.pdp,
      webBotAuth: options.webBotAuth,
      adapter: 'node',
      wrap: (dock: PermDock) => applyOtel(dock, options.otel),
    }),
  );

  const bind = (req: IncomingMessage): globalThis.Request => {
    const hit = bound.get(req);
    if (hit !== undefined) {
      return hit;
    }
    const nodeReq = req as NodeRequest;
    const request = toRequest(nodeReq);
    bound.set(req, request);
    contexts.set(request, nodeReq);
    return request;
  };

  const scopeOf = (req: IncomingMessage): Promise<TenantScope> =>
    tenantScope(options.tenant, req as NodeRequest);

  const permdock = async (req: IncomingMessage): Promise<PermDock> =>
    kernel.permdock(bind(req), await scopeOf(req));

  const protect =
    (
      permission: Permission,
      loadData?: (req: NodeRequest) => unknown,
      protectOptions?: ProtectOptions,
    ): ((req: IncomingMessage) => Promise<Guard>) =>
    async (req: IncomingMessage): Promise<Guard> =>
      kernel.protect(
        permission,
        loadData === undefined
          ? undefined
          : (): unknown => loadData(req as NodeRequest),
        protectOptions,
      )(bind(req), await scopeOf(req));

  const permdockHandler = (): ((
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>) => {
    const { POST, GET } = kernel.handler((request) => {
      const req = contexts.get(request);
      return req === undefined ? { tenant: undefined } : scopeOf(req);
    });
    return async (req, res): Promise<void> => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        await sendResponse(res, await GET(bind(req)));
        return;
      }
      const nodeReq = req as NodeRequest;
      const request = toRequest(nodeReq);
      contexts.set(request, nodeReq);
      await sendResponse(res, await POST(request));
    };
  };

  return {
    permdock,
    protect,
    send: sendResponse,
    permdockHandler,
    toRequest,
    fromResponse,
    openapi: kernel.openapi,
  };
}
