import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApprovalStore } from "../approvals/types.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { SnapshotSource } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { Principal } from "../core/subject.ts";
import type { OtelWrap } from "../otel/types.ts";
import type { PdpFactory } from "../pdp/types.ts";
import type {
  Guard,
  OpenApiHooks,
  ProtectOptions,
  TenantOption,
  TenantScope,
} from "../server/create.ts";
import type { WebBotAuthVerifier } from "../server/web-bot-auth.ts";

import { compact } from "../core/compact.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { createKernel, tenantScope } from "../server/create.ts";
import {
  fromResponse,
  sendResponse,
  toRequest,
  type NodeRequest,
} from "./http.ts";

export type NodePermDockOptions<TUser = unknown> = InstanceOptions & {
  readonly subject: (req: NodeRequest) => TUser | Promise<TUser>;
  /** The agent or service acting for the subject; anything but an `Actor` is ignored. */
  readonly actor?: (req: NodeRequest) => unknown;
  readonly tenant?: TenantOption<NodeRequest>;
  readonly store?: ApprovalStore;
  /** `createPermDock` from `permdock/pdp`; `protect` then decides delegated permissions remotely. */
  readonly pdp?: PdpFactory;
  /** @deprecated Not read by any adapter. */
  readonly snapshots?: SnapshotSource;
  /** `(permdock) => withOtel(permdock, options)` from `permdock/otel`. */
  readonly otel?: OtelWrap;
  /** `(request) => verifyWebBotAuth(request, options)`; a verified bot becomes the actor. */
  readonly webBotAuth?: WebBotAuthVerifier;
};

export type NodePermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly permdock: (req: IncomingMessage) => Promise<PermDock<V>>;
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

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: NodePermDockOptions<TUser>,
): NodePermDock<V> {
  const contexts = new WeakMap<globalThis.Request, NodeRequest>();
  const bound = new WeakMap<IncomingMessage, globalThis.Request>();
  const kernel = createKernel(
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
      adapter: "node",
      wrap: options.otel,
    }),
  );

  const bind = (req: IncomingMessage): globalThis.Request => {
    const hit = bound.get(req);
    if (hit !== undefined) {
      return hit;
    }
    // SAFETY: NodeRequest only adds optional fields that Express-style servers set on the request.
    const nodeReq = req as NodeRequest;
    const request = toRequest(nodeReq);
    bound.set(req, request);
    contexts.set(request, nodeReq);
    return request;
  };

  // SAFETY: NodeRequest only adds optional fields that Express-style servers set on the request.
  const scopeOf = (req: IncomingMessage): Promise<TenantScope> =>
    tenantScope(options.tenant, req as NodeRequest);

  const permdock = async (req: IncomingMessage): Promise<PermDock<V>> =>
    kernel.permdock(bind(req), await scopeOf(req));

  // SAFETY: NodeRequest only adds optional fields that Express-style servers set on the request.
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
    const { POST, GET } = kernel.permdockHandler((request) => {
      const req = contexts.get(request);
      return req === undefined ? { tenant: undefined } : scopeOf(req);
    });
    return async (req, res): Promise<void> => {
      if (req.method === "GET" || req.method === "HEAD") {
        await sendResponse(res, await GET(bind(req)));
        return;
      }
      // SAFETY: NodeRequest only adds optional fields that Express-style servers set on the request.
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
