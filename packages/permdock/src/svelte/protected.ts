import type { Snippet } from "svelte";

import type { ClientStore } from "../client/store.ts";
import type {
  ApprovalRequiredDecision,
  Decision,
  GrantedDecision,
} from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";

import {
  type ProtectedView,
  protectedView,
  scopedTenant,
} from "../client/views.ts";

export { slotContent } from "../client/views.ts";

export type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
  readonly children?: Snippet<[GrantedDecision]>;
  readonly pending?: Snippet;
  readonly denied?: Snippet<[Decision]>;
  /** Rendered for an approval-required decision; defaults to `denied`. */
  readonly approval?: Snippet<[ApprovalRequiredDecision]>;
};

/** The instance for `tenant`, built once per store change rather than once per check. */
export function scopedFor(
  store: ClientStore,
  tenant: string | undefined,
  _generation?: number,
): PermDock | undefined {
  return scopedTenant(store.get(), tenant);
}

export function viewFor(
  store: ClientStore,
  reference: Permission,
  data: unknown,
  scoped: PermDock | undefined,
  _generation?: number,
): ProtectedView {
  return protectedView(
    store.permissionState(reference, data),
    store.get(),
    reference,
    data,
    scoped,
  );
}
