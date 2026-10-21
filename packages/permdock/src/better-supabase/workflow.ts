import type {
  AuthorizeHookOptions,
  ProtectWebHandlerOptions,
} from "better-supabase/workflow-sdk";

import type { PermDock } from "../core/permdock.ts";

import { findPermission } from "../core/permission-registry.ts";

/**
 * Where `handlerCan` gets the request's instance, such as `permdock/server`'s
 * `createPermDock` result.
 */
export type HandlerPermDockSource = {
  readonly getPermDock: (request: Request) => PermDock | Promise<PermDock>;
};

/**
 * Whether `permdock` is granted the permission `key` (a catalog key or scope)
 * with no row.
 */
function grants(permdock: PermDock, key: string): boolean {
  try {
    const permission = findPermission(permdock.permissions, key);
    return (
      permission !== undefined &&
      permdock.decide(permission, undefined).outcome === "granted"
    );
  } catch {
    return false;
  }
}

/**
 * The `can` option of better-supabase's `authorizeHook`, for the caller's
 * `permdock`: `true` only when the caller is a member of the hook's tenant and
 * `decide` grants the permission its `hookMetadata` names there. An unknown
 * key, `approval-required` and a throw are `false`.
 */
export function hookCan(
  permdock: PermDock,
): NonNullable<AuthorizeHookOptions["can"]> {
  return (tenant, key) => {
    try {
      return (
        permdock.tenants().includes(tenant) &&
        grants(permdock.tenant(tenant), key)
      );
    } catch {
      return false;
    }
  };
}

/**
 * The `can` option of better-supabase's `protectWebHandler`: `undefined` (401)
 * when the request has no signed-in principal or `getPermDock` throws,
 * otherwise whether `decide` grants the permission in the request's active
 * tenant. An unknown key and `approval-required` are `false` (403).
 */
export function handlerCan(
  source: HandlerPermDockSource,
): ProtectWebHandlerOptions["can"] {
  return async (request, key) => {
    let permdock: PermDock;
    try {
      permdock = await source.getPermDock(request);
    } catch {
      return undefined;
    }
    if (permdock.subject.principal === null) {
      return undefined;
    }
    return grants(permdock, key);
  };
}
