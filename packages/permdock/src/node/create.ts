import type { IncomingMessage, ServerResponse } from "node:http";

import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Principal } from "../core/subject.ts";
import type { ServerAdapterOptions } from "../server/bind.ts";
import type { TenantScope } from "../server/create.ts";
import type {
  Guard,
  OpenApiHooks,
  ProtectOptions,
  ScopeGuard,
} from "../server/server-types.ts";

import { bindKernel } from "../server/kit.ts";
import { sendResponse, toRequest, type NodeRequest } from "./http.ts";

export type NodePermDockOptions<TUser = unknown> = ServerAdapterOptions<
  NodeRequest,
  TUser
>;

type NodeProtect = {
  (
    permission: Permission,
    data?: (req: NodeRequest) => unknown,
    protectOptions?: ProtectOptions,
  ): (req: IncomingMessage) => Promise<Guard>;
  (
    permission: null,
    data?: (req: NodeRequest) => unknown,
    protectOptions?: ProtectOptions,
  ): (req: IncomingMessage) => Promise<ScopeGuard>;
};

export type NodePermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly getPermDock: (req: IncomingMessage) => Promise<PermDock<V>>;
  readonly protect: NodeProtect;
  readonly send: typeof sendResponse;
  readonly permdockHandler: () => (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  readonly toRequest: typeof toRequest;
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

  const getPermDock = async (req: IncomingMessage): Promise<PermDock<V>> =>
    kernel.getPermDock(bind(req), await scopeOf(req));

  // SAFETY: NodeProtect's overloads only narrow the guard by whether permission is null, as the kernel's do.
  const protect = ((
    permission: Permission | null,
    data?: (req: NodeRequest) => unknown,
    protectOptions?: ProtectOptions,
  ): ((req: IncomingMessage) => Promise<Guard | ScopeGuard>) =>
    (req: IncomingMessage): Promise<Guard | ScopeGuard> =>
      bound.guard(
        permission,
        data,
        nodeRequest(req),
        protectOptions,
      )) as NodeProtect;

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
    getPermDock,
    protect,
    send: sendResponse,
    permdockHandler,
    toRequest,
    openapi: kernel.openapi,
  };
}
