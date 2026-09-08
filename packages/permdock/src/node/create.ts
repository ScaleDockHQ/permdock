import type { IncomingMessage, ServerResponse } from 'node:http';

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
import type { Guard, OpenApiHooks } from '../server/create.ts';

import { compact } from '../core/compact.ts';
import { applyOtel } from '../otel/instrument.ts';
import { createPermDock as createKernel } from '../server/create.ts';
import {
  fromResponse,
  sendResponse,
  toRequest,
  type NodeRequest,
} from './http.ts';

export type NodePermDockOptions = {
  readonly subject: (req: NodeRequest) => unknown;
  readonly tenant?:
    | string
    | ((req: NodeRequest) => string | undefined | Promise<string | undefined>);
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
};

export type NodePermDock = {
  readonly permdock: (req: IncomingMessage) => Promise<PermDock>;
  readonly protect: (
    permission: Permission,
    loadData?: (req: NodeRequest) => unknown,
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

export function createPermDock(
  policy: Policy,
  options: NodePermDockOptions,
): NodePermDock {
  const contexts = new WeakMap<globalThis.Request, NodeRequest>();
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

  const permdock = (req: IncomingMessage): Promise<PermDock> =>
    kernel.permdock(bind(req));

  const protect =
    (
      permission: Permission,
      loadData?: (req: NodeRequest) => unknown,
    ): ((req: IncomingMessage) => Promise<Guard>) =>
    (req: IncomingMessage): Promise<Guard> =>
      kernel.protect(
        permission,
        loadData === undefined
          ? undefined
          : (): unknown => loadData(req as NodeRequest),
      )(bind(req));

  const permdockHandler = (): ((
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>) => {
    const { POST, GET } = kernel.handler();
    return async (req, res): Promise<void> => {
      const request = bind(req);
      if (req.method === 'GET' || req.method === 'HEAD') {
        await sendResponse(res, await GET(request));
        return;
      }
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
