"use client";

export { describe, requiredPlans } from "../core/describe.ts";
export { approvalHeaders } from "../client/headers.ts";
export { eventSourceRefresh } from "../client/refresh-on.ts";
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
} from "../react/hooks.ts";
export { Protected } from "../react/protected.tsx";
export { useProtectedAction } from "../react/protected-action.ts";
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
  PermissionSet,
  PermissionState,
  SubjectView,
  TenantView,
} from "../client/types.ts";
export type { PermDockDefaults, ProtectedProps } from "../react/types.ts";
export { parseLocalSnapshotManifest } from "../core/parse-local-manifest.ts";
export { useSnapshotReady, usePermissionGuard } from "./guards.ts";
export { buildLocalSnapshot, localSnapshot } from "./local.ts";
export type { LocalSnapshotData, LocalSnapshotOptions } from "./local.ts";
export { powerSyncSource, powerSyncSourceCache } from "./powersync.ts";
export type {
  PowerSyncQuery,
  PowerSyncSourceCache,
  PowerSyncSourceOptions,
  PowerSyncWatchable,
} from "./powersync.ts";
export { PermDockProvider } from "./provider.tsx";
export { memorySnapshotStorage } from "./storage.ts";
export { mmkvStorage, secureStoreStorage } from "./storage-adapters.ts";
export type { MmkvInstance, SecureStoreModule } from "./storage-adapters.ts";
export { appStateForeground, netInfoOnline } from "./subscriptions.ts";
export type { AppStateModule, NetInfoModule } from "./subscriptions.ts";
export { connectSource, nativeStore } from "./store.ts";
export type { SnapshotSource } from "../core/interfaces.ts";
export type {
  LocalMembershipRows,
  LocalRowColumn,
  LocalRowValue,
  LocalSnapshotManifest,
  LocalSnapshotRows,
} from "../core/snapshot-types.ts";
export type {
  ReactNativePermDockProviderProps,
  NativeRevalidate,
  SnapshotStorage,
  SubscribeForeground,
  SubscribeOnline,
} from "./types.ts";
export type {
  EventSourceRefreshOptions,
  RefreshTrigger,
} from "../client/refresh-on.ts";
export type { ActionResult, ProtectedAction } from "../core/action-result.ts";
