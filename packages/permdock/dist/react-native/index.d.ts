import { f as SnapshotV2, g as TokenVerifier } from "../interfaces-B19qT0zU.js";
import { d as describe } from "../permdock-BFyP-l5_.js";
import { a as FilterResult, c as PermissionState, d as TenantView, i as ClientStatus, l as ProtectedProps, n as ApprovalState, p as approvalHeaders, r as ClientPermDock, s as PermissionSet, t as ApprovalHandle, u as SubjectView } from "../types-DN9PS-Hn.js";
import { a as useMemberships, c as usePermissions, d as useTenant, i as useFilter, l as useRoles, n as useApproval, o as usePermDock, r as useAssignableRoles, s as usePermission, t as Protected, u as useSubject } from "../protected-nO-Pt7hh.js";
import { t as ClientStore } from "../store-CMuVRAjj.js";
import { ReactElement, ReactNode } from "react";
//#region src/react-native/types.d.ts
type PermDockStorage = {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
};
type NativeRevalidate = "launch" | "focus" | number;
type NativePermDockProviderProps = {
  readonly storage: PermDockStorage;
  readonly snapshot?: SnapshotV2 | string;
  readonly snapshotUrl?: string;
  readonly endpoint?: string;
  readonly approvals?: string;
  readonly tenant?: string;
  readonly subjectId?: string;
  readonly revalidate?: NativeRevalidate;
  readonly subscribeForeground?: (listener: () => void) => () => void;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
  readonly children: ReactNode;
};
//#endregion
//#region src/react-native/provider.d.ts
export declare function PermDockProvider(props: NativePermDockProviderProps): ReactElement;
//#endregion
//#region src/react-native/storage.d.ts
export declare function memoryStorage(initial?: Readonly<Record<string, string>>): PermDockStorage;
//#endregion
//#region src/react-native/store.d.ts
type NativeStoreOptions = Omit<NativePermDockProviderProps, "children">;
export declare function createNativeStore(options: NativeStoreOptions): ClientStore;
//#endregion
export { type ApprovalHandle, type ApprovalState, type ClientPermDock, type ClientStatus, type FilterResult, type NativePermDockProviderProps, type NativeRevalidate, type PermDockStorage, type PermissionSet, type PermissionState, Protected, type ProtectedProps, type SubjectView, type TenantView, approvalHeaders, describe, useApproval, useAssignableRoles, useFilter, useMemberships, usePermDock, usePermission, usePermissions, useRoles, useSubject, useTenant };