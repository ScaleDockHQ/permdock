import type { Snippet } from "svelte";

import type { PermissionBoundaryState } from "../client/boundary.ts";

export type PermissionBoundaryProps = {
  readonly children?: Snippet;
  /** Rendered in place of the children when one throws `PermDockDeniedError`. */
  readonly denied?: Snippet<[PermissionBoundaryState]>;
  /** Rendered for `PermDockApprovalRequiredError`; defaults to `denied`. */
  readonly approval?: Snippet<[PermissionBoundaryState]>;
};
