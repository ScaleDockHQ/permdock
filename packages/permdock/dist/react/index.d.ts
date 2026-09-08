import { D as Principal, E as Membership, m as TokenVerifier, u as SnapshotV2, w as Delegation, y as Actor } from "../interfaces-D45oN5-b.js";
import { T as Permission, n as Decision } from "../decision-JylG_mtz.js";
import { d as describe, r as PermDock } from "../permdock-DQYQWaf9.js";
import { ReactElement, ReactNode } from "react";
//#region src/react/headers.d.ts
export declare function approvalHeaders(token: string): {
  readonly "PermDock-Approval": string;
};
//#endregion
//#region src/react/types.d.ts
type ClientStatus = "ready" | "pending" | "stale" | "server-only";
type PermissionState = {
  readonly allowed: boolean;
  readonly status: ClientStatus;
  readonly decision: Decision;
};
type PermissionSet = {
  readonly granted: readonly Permission[];
  get(permission: Permission): PermissionState | undefined;
};
type ClientPermDock = PermDock & {
  status(permission?: Permission, data?: unknown): ClientStatus;
  invalidate(ref: Permission | {
    readonly [key: string]: unknown;
  }): void;
  refresh(options?: {
    readonly tenant?: string;
  }): Promise<void>;
  subscribe(listener: () => void): () => void;
};
type ApprovalState = "not-needed" | "required" | "pending" | "approved" | "rejected" | "expired";
type ApprovalHandle = {
  readonly state: ApprovalState;
  readonly token: string | undefined;
  readonly request: (note?: string) => Promise<void>;
};
type SubjectView = {
  readonly principal: Principal | null;
  readonly actor: Actor | undefined;
  readonly delegation: Delegation | undefined;
  readonly expiresAt: number | undefined;
  readonly simulated: boolean;
};
type TenantView = {
  readonly tenant: string | null;
  readonly tenants: readonly string[];
  readonly switchTo: (id: string) => Promise<void>;
  readonly status: ClientStatus;
};
type FilterResult<T> = readonly T[] & {
  readonly partial: boolean;
};
type PermDockProviderProps = {
  readonly snapshot: SnapshotV2 | string;
  readonly endpoint?: string;
  readonly approvals?: string;
  readonly tenant?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
  readonly children: ReactNode;
};
type UseRolesOptions = {
  readonly tenant?: string;
  readonly team?: string;
};
type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
  readonly pending?: ReactNode;
  readonly fallback?: ReactNode | ((decision: Decision) => ReactNode);
  readonly children: ReactNode | ((decision: Extract<Decision, {
    readonly outcome: "granted";
  }>) => ReactNode);
};
//#endregion
//#region src/react/hooks.d.ts
export declare function usePermDock(): ClientPermDock;
export declare function usePermission(permission: Permission, data?: unknown): PermissionState;
export declare function usePermissions(permissions: readonly Permission[], data?: unknown): PermissionSet;
export declare function useFilter<T>(permission: Permission<string, T, "instance">, rows: readonly T[]): FilterResult<T>;
export declare function useTenant(): TenantView;
export declare function useMemberships(): readonly Membership[];
export declare function useRoles(options?: UseRolesOptions): {
  readonly roles: readonly string[];
};
export declare function useAssignableRoles(): readonly string[];
export declare function useSubject(): SubjectView;
export declare function useApproval(decision: Decision): ApprovalHandle;
//#endregion
//#region src/react/provider.d.ts
export declare function PermDockProvider(props: PermDockProviderProps): ReactElement;
//#endregion
//#region src/react/protected.d.ts
export declare function Protected(props: ProtectedProps): ReactNode;
//#endregion
export { type ApprovalHandle, type ApprovalState, type ClientPermDock, type ClientStatus, type FilterResult, type PermDockProviderProps, type PermissionSet, type PermissionState, type ProtectedProps, type SubjectView, type TenantView, describe };