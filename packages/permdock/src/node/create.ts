import type { IncomingMessage, ServerResponse } from "node:http";

import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { Principal } from "../core/subject.ts";
import type { ServerAdapterOptions } from "../server/bind.ts";
import type {
  Guard,
  OpenApiHooks,
  ProtectOptions,
  ScopeGuard,
  TenantScope,
} from "../server/create.ts";

import { bindKernel } from "../server/bind.ts";
import {
  fromResponse,
  sendResponse,
  toRequest,
  type NodeRequest,
} from "./http.ts";

export type NodePermDockOptions<TUser = unknown> = ServerAdapterOptions<
  NodeRequest,
  TUser
>;

type NodeProtect = {
  (
    permission: Permission,
    loadData?: (req: NodeRequest) => unknown,
    protectOptions?: ProtectOptions,
  ): (req: IncomingMessage) => Promise<Guard>;
  (
    permission: null,
    loadData?: (req: NodeRequest) => unknown,
    protectOptions?: ProtectOptions,
  ): (req: IncomingMessage) => Promise<ScopeGuard>;
};

export type NodePermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly permdock: (req: IncomingMessage) => Promise<PermDock<V>>;
  readonly protect: NodeProtect;
  readonly send: typeof sendResponse;
  readonly permdockHandler: () => (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  readonly toRequest: typeof toRequest;
  readonly fromResponse: typeof fromResponse;
  readonly openapi: OpenApiHooks;
};

// SAFETY: NodeRequest only adds optional fields that Express-style servers set on the request.
const nodeRequest = (req: IncomingMessage): NodeRequest => req as NodeRequest;

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: NodePermDockOptions<TUser>,
): NodePermDock<V> {
  const bound = bindKernel(policy, options, "node", toRequest);
  const { kernel, handlerScope } = bound;
  const bind = (req: IncomingMessage): globalThis.Request =>
    bound.bind(nodeRequest(req));
  const scopeOf = (req: IncomingMessage): Promise<TenantScope> =>
    bound.scopeOf(nodeRequest(req));

  const permdock = async (req: IncomingMessage): Promise<PermDock<V>> =>
    kernel.permdock(bind(req), await scopeOf(req));

  // SAFETY: NodeProtect's overloads only narrow the guard by whether permission is null, as the kernel's do.
  const protect = ((
    permission: Permission | null,
    loadData?: (req: NodeRequest) => unknown,
    protectOptions?: ProtectOptions,
  ): ((req: IncomingMessage) => Promise<Guard | ScopeGuard>) =>
    async (req: IncomingMessage): Promise<Guard | ScopeGuard> =>
      kernel.protect(
        permission,
        loadData === undefined
          ? undefined
          : (): unknown => loadData(nodeRequest(req)),
        protectOptions,
      )(bind(req), await scopeOf(req))) as NodeProtect;

  const permdockHandler = (): ((
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>) => {
    const { POST, GET } = kernel.permdockHandler(handlerScope);
    return async (req, res): Promise<void> => {
      if (req.method === "GET" || req.method === "HEAD") {
        await sendResponse(res, await GET(bind(req)));
        return;
      }
      await sendResponse(res, await POST(bound.rebind(nodeRequest(req))));
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
