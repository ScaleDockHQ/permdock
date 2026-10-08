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
export { parseLocalSnapshotManifest } from "../core/parse-local-manifest.ts";
export { useSnapshotReady, usePermissionGuard } from "./guards.ts";
export { buildLocalSnapshot, localSnapshot } from "./local.ts";
export type { LocalSnapshotData, LocalSnapshotOptions } from "./local.ts";
export { powersyncSource } from "./powersync.ts";
export type {
  PowerSyncQuery,
  PowerSyncSourceOptions,
  PowerSyncWatchable,
} from "./powersync.ts";
export { PermDockProvider } from "./provider.tsx";
export { memoryStorage } from "./storage.ts";
export { mmkvStorage, secureStoreStorage } from "./storage-adapters.ts";
export type { MmkvInstance, SecureStoreModule } from "./storage-adapters.ts";
export { appStateForeground, netInfoOnline } from "./subscriptions.ts";
export type { AppStateModule, NetInfoModule } from "./subscriptions.ts";
export { connectSource, createNativeStore } from "./store.ts";
export type {
  LocalSnapshotManifest,
  SnapshotSource,
} from "../core/interfaces.ts";
export type {
  NativePermDockProviderProps,
  NativeRevalidate,
  PermDockStorage,
  SubscribeForeground,
  SubscribeOnline,
} from "./types.ts";
