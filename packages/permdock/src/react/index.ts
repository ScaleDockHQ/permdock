"use client";

export {
  describe,
  requiredPlans,
  approvalHeaders,
  eventSourceRefresh,
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
  useRoles,
  useSubject,
  useTenant,
} from "./hooks.ts";
export { PermDockProvider } from "./provider.tsx";
export { Protected } from "./protected.tsx";
export type {
  ApprovalHandle,
  ApprovalState,
  ClientPermDock,
  ClientStatus,
  FilterResult,
  GateMode,
  GateView,
  PermDockDefaults,
  PermDockProviderProps,
  PermissionSet,
  PermissionState,
  ProtectedProps,
  SubjectView,
  TenantView,
} from "./types.ts";
export type {
  EventSourceRefreshOptions,
  RefreshTrigger,
} from "../client/refresh-on.ts";
