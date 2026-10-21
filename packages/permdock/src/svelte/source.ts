import type { Component } from "svelte";

import type { PermissionBoundaryProps } from "./boundary.ts";
import type { ProtectedProps } from "./protected.ts";

// Kept as source: the app's Svelte compiler builds it for SSR or the client.
import PermissionBoundaryComponent from "./PermissionBoundary.svelte";
import ProtectedComponent from "./Protected.svelte";
export {
  describe,
  requiredPlans,
  approvalHeaders,
  eventSourceRefresh,
} from "../client/kit.ts";

export { setPermDock } from "./stores.ts";
export {
  approval,
  assignable,
  assignablePermissions,
  filtered,
  gate,
  protectedAction,
  getDescribe,
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
  GateMode,
  GateView,
  ProtectedActionReadable,
  ProtectedActionView,
  PermDockDefaults,
  SveltePermDockOptions,
  PermissionSet,
  PermissionState,
  SubjectView,
  TenantView,
  RolesOptions,
} from "./types.ts";

export type { PermissionBoundaryState } from "../client/boundary.ts";
export type { PermissionBoundaryProps } from "./boundary.ts";
export type { ProtectedProps } from "./protected.ts";

export const Protected: Component<ProtectedProps> = ProtectedComponent;

export const PermissionBoundary: Component<PermissionBoundaryProps> =
  PermissionBoundaryComponent;
export type {
  EventSourceRefreshOptions,
  RefreshTrigger,
} from "../client/refresh-on.ts";
export type { ActionResult, ProtectedAction } from "../core/action-result.ts";
