"use client";

export {
  describe,
  requiredPlans,
  approvalHeaders,
  eventSourceRefresh,
  focusRefresh,
  visibilityRefresh,
  broadcastChannelRefresh,
  authzChangeRefresh,
} from "../client/kit.ts";

export {
  useApproval,
  useAssignablePermissions,
  useAssignableRoles,
  useDescribe,
  useFilter,
  useGate,
  useMemberships,
  usePermDock,
  usePermission,
  usePermissions,
  useRefreshOn,
  useRoles,
  useSubject,
  useTenant,
} from "./hooks.ts";
export { PermDockProvider } from "./provider.tsx";
export { Protected } from "./protected.tsx";
export { useProtectedAction } from "./protected-action.ts";
export type {
  ApprovalHandle,
  ApprovalState,
  ClientPermDock,
  ClientStatus,
  FilterResult,
  GateMode,
  GateView,
  ProtectedActionHandle,
  ProtectedActionView,
  RolesOptions,
  PermDockDefaults,
  PermDockProviderProps,
  PermissionSet,
  PermissionState,
  ProtectedProps,
  SubjectView,
  TenantView,
} from "./types.ts";
export type {
  AuthzChangeRefresh,
  EventSourceRefreshOptions,
  RefreshTrigger,
} from "../client/refresh-on.ts";
export type { ActionResult, ProtectedAction } from "../core/action-result.ts";
