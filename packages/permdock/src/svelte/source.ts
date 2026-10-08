import type { Component } from "svelte";

import type { PermissionBoundaryProps } from "./boundary.ts";
import type { ProtectedProps } from "./protected.ts";

// Kept as source: the app's Svelte compiler builds it for SSR or the client.
import PermissionBoundaryComponent from "./PermissionBoundary.svelte";
import ProtectedComponent from "./Protected.svelte";

export { describe, requiredPlans } from "../core/describe.ts";
export { approvalHeaders } from "../react/headers.ts";
export { setPermDock } from "./stores.ts";
export {
  approval,
  assignable,
  assignablePermissions,
  filtered,
  getPermDock,
  memberships,
  permission,
  permissions,
  roles,
  subject,
  tenant,
} from "./stores.ts";
export type {
  ApprovalHandle,
  ApprovalState,
  ClientPermDock,
  ClientStatus,
  FilterResult,
  PermDockSvelteOptions,
  PermissionSet,
  PermissionState,
  SubjectView,
  TenantView,
  UseRolesOptions,
} from "./types.ts";

export type {
  PermissionBoundaryProps,
  PermissionBoundaryState,
} from "./boundary.ts";
export type { ProtectedProps } from "./protected.ts";

export const Protected: Component<ProtectedProps> = ProtectedComponent;

export const PermissionBoundary: Component<PermissionBoundaryProps> =
  PermissionBoundaryComponent;
