import type { Snippet } from "svelte";

import type { ProtectedView } from "../client/views.ts";
import type { Decision } from "../core/decision.ts";
import type { Permission } from "../core/permissions.ts";
import type { ClientStore } from "../react/store.ts";

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

export function protectedView(
  store: ClientStore,
  reference: Permission,
  data?: unknown,
  tenant?: string,
  _generation?: number,
): ProtectedView {
  return viewOf(
    store.permissionState(reference, data),
    store.get(),
    reference,
    data,
    tenant,
  );
}
