"use client";

import type { Context, ReactNode } from "react";

import { createContext, useContext, useMemo } from "react";

import type { Permission } from "../core/permission-types.ts";

const GrantedContext: Context<ReadonlySet<string> | null> =
  createContext<ReadonlySet<string> | null>(null);

export type LitePermissionState = { readonly allowed: boolean };

export type LiteProviderProps = {
  /**
   * What the server's `permdock.grantedPermissions()` lists for the active
   * tenant. A permission is allowed when it is in the list; the list is the
   * only input, so nothing here evaluates a policy.
   */
  readonly granted: readonly Permission[];
  readonly children: ReactNode;
};

export type LiteProtectedProps = {
  readonly permission: Permission;
  readonly denied?: ReactNode;
  readonly children: ReactNode;
};

export function PermDockProvider(props: LiteProviderProps): ReactNode {
  const keys = useMemo(
    () => new Set(props.granted.map((permission) => permission.key)),
    [props.granted],
  );
  return (
    <GrantedContext.Provider value={keys}>
      {props.children}
    </GrantedContext.Provider>
  );
}

/**
 * Whether `permission` is in the provider's granted list, matched by `key`.
 * Without a provider nothing is granted.
 */
export function usePermission(permission: Permission): LitePermissionState {
  const keys = useContext(GrantedContext);
  return { allowed: keys?.has(permission.key) === true };
}

export function Protected(props: LiteProtectedProps): ReactNode {
  return usePermission(props.permission).allowed
    ? props.children
    : (props.denied ?? null);
}
