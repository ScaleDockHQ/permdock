import type { Snippet } from "svelte";

import type { ClientStore } from "../client/store.ts";
import type { ProtectedView } from "../client/views.ts";
import type { Decision } from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";

import { protectedView as viewOf } from "../client/views.ts";

export type { ProtectedView } from "../client/views.ts";

export type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
  readonly children?: Snippet<[Decision]>;
  readonly pending?: Snippet;
  readonly fallback?: Snippet<[Decision]>;
};

/** The instance for `tenant`, built once per store change rather than once per check. */
export function scopedFor(
  store: ClientStore,
  tenant: string | undefined,
  _generation?: number,
): PermDock | undefined {
  return tenant === undefined ? undefined : store.get().tenant(tenant);
}

export function protectedView(
  store: ClientStore,
  reference: Permission,
  data: unknown,
  scoped: PermDock | undefined,
  _generation?: number,
): ProtectedView {
  return viewOf(
    store.permissionState(reference, data),
    store.get(),
    reference,
    data,
    scoped,
  );
}
