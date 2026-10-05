"use client";

export { describe, requiredPlans } from "../core/describe.ts";
export { approvalHeaders } from "../react/headers.ts";
export {
  useApproval,
  useAssignablePermissions,
  useAssignableRoles,
  useFilter,
  useMemberships,
  usePermDock,
  usePermission,
  usePermissions,
  useRoles,
  useSubject,
  useTenant,
} from "../react/hooks.ts";
export { Protected } from "../react/protected.tsx";
export type {
  ApprovalHandle,
  ApprovalState,
  ClientPermDock,
  ClientStatus,
  FilterResult,
  PermissionSet,
  PermissionState,
  ProtectedProps,
  SubjectView,
  TenantView,
} from "../react/types.ts";
export { buildLocalSnapshot, localSnapshot } from "./local.ts";
export type { LocalSnapshotData, LocalSnapshotOptions } from "./local.ts";
export { PermDockProvider } from "./provider.tsx";
export { memoryStorage } from "./storage.ts";
export { connectSource, createNativeStore } from "./store.ts";
export type {
  LocalSnapshotManifest,
  SnapshotSource,
} from "../core/interfaces.ts";
export type {
  NativePermDockProviderProps,
  NativeRevalidate,
  PermDockStorage,
} from "./types.ts";
