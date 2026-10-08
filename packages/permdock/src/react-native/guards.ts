import { useMemo } from "react";

import type { Permission } from "../core/permissions.ts";

import { usePermDock } from "../react/hooks.ts";
import { storeOf } from "../react/store.ts";

/** `true` once the provider has a snapshot to answer from: storage was read or a seed was given. Hide the splash screen on it. */
export function useSnapshotReady(): boolean {
  return usePermDock().status() !== "pending";
}

/**
 * A boolean for `Stack.Protected` and `Tabs.Protected`: `false` while the
 * snapshot is pending, `true` only when every permission is allowed for
 * `data`.
 */
export function usePermissionGuard(
  permission: Permission | readonly Permission[],
  data?: unknown,
): boolean {
  const permdock = usePermDock();
  return useMemo(() => {
    if (permdock.status() === "pending") {
      return false;
    }
    const store = storeOf(permdock);
    const list: readonly Permission[] = Array.isArray(permission)
      ? permission
      : [permission];
    return (
      list.length > 0 &&
      list.every((item) => store.permissionState(item, data).allowed)
    );
  }, [permdock, permission, data]);
}
