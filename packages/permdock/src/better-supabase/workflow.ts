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

export type HookCanOptions = {
  /**
   * Loads the row the permission `key` is decided on in `tenant`, so a
   * condition on the row applies. Without it there is no row; a throw is
   * `false`.
   */
  readonly data?: (tenant: string, key: string) => unknown;
};

export type HandlerCanOptions = {
  /**
   * Loads the row the permission `key` is decided on for `request`, so a
   * condition on the row applies. Without it there is no row; a throw is
   * `false` (403).
   */
  readonly data?: (request: Request, key: string) => unknown;
};

/**
 * Whether `permdock` is granted the permission `key` (a catalog key or scope)
 * on `row`.
 */
function grants(permdock: PermDock, key: string, row?: unknown): boolean {
  try {
    const permission = findPermission(permdock.permissions, key);
    return (
      permission !== undefined &&
      permdock.decide(permission, row).outcome === "granted"
    );
  } catch {
    return false;
  }
}

/**
 * The `can` option of better-supabase's `authorizeHook`, for the caller's
 * `permdock`: `true` only when the caller is a member of the hook's tenant and
 * `decide` grants the permission its `hookMetadata` names there, on the row
 * `options.data` loads. An unknown key, `approval-required` and a throw are
 * `false`.
 */
export function hookCan(
  permdock: PermDock,
  options: HookCanOptions = {},
): NonNullable<AuthorizeHookOptions["can"]> {
  const { data } = options;
  const decideIn = (tenant: string, key: string, row?: unknown): boolean => {
    try {
      return (
        permdock.tenants().includes(tenant) &&
        grants(permdock.tenant(tenant), key, row)
      );
    } catch {
      return false;
    }
  };
  if (data === undefined) {
    return (tenant, key) => decideIn(tenant, key);
  }
  return async (tenant, key) => {
    let row: unknown;
    try {
      if (!permdock.tenants().includes(tenant)) {
        return false;
      }
      row = await data(tenant, key);
    } catch {
      return false;
    }
    return decideIn(tenant, key, row);
  };
}

/**
 * The `can` option of better-supabase's `protectWebHandler`: `undefined` (401)
 * when the request has no signed-in principal or `getPermDock` throws,
 * otherwise whether `decide` grants the permission in the request's active
 * tenant, on the row `options.data` loads. An unknown key, `approval-required`
 * and a throwing `data` are `false` (403).
 */
export function handlerCan(
  source: HandlerPermDockSource,
  options: HandlerCanOptions = {},
): ProtectWebHandlerOptions["can"] {
  const { data } = options;
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
    if (data === undefined) {
      return grants(permdock, key);
    }
    try {
      const row: unknown = await data(request, key);
      return grants(permdock, key, row);
    } catch {
      return false;
    }
  };
}
