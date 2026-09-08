import { d as Delegation, h as Principal, m as Membership, o as Actor } from "./ast-BtUySn6K.js";
import { v as Permission } from "./policy-Dvre0Da9.js";
import { n as Decision } from "./decision-BvyrBh2L.js";
import { m as TokenVerifier, u as SnapshotV2 } from "./interfaces-DMSVa7et.js";
import { r as PermDock } from "./permdock-ChXNJ7qn.js";
import { ReactNode } from "react";
//#region src/react/headers.d.ts
declare function approvalHeaders(token: string): {
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
  clear(): void;
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
declare function usePermDock(): ClientPermDock;
declare function usePermission(permission: Permission, data?: unknown): PermissionState;
declare function usePermissions(permissions: readonly Permission[], data?: unknown): PermissionSet;
declare function useFilter<T>(permission: Permission<string, T, "instance">, rows: readonly T[]): FilterResult<T>;
declare function useTenant(): TenantView;
declare function useMemberships(): readonly Membership[];
declare function useRoles(options?: UseRolesOptions): {
  readonly roles: readonly string[];
};
declare function useAssignableRoles(): readonly string[];
declare function useSubject(): SubjectView;
declare function useApproval(decision: Decision): ApprovalHandle;
//#endregion
//#region src/react/protected.d.ts
declare function Protected(props: ProtectedProps): ReactNode;
//#endregion
export { approvalHeaders as C, TenantView as S, PermDockProviderProps as _, useMemberships as a, ProtectedProps as b, usePermissions as c, useTenant as d, ApprovalHandle as f, FilterResult as g, ClientStatus as h, useFilter as i, useRoles as l, ClientPermDock as m, useApproval as n, usePermDock as o, ApprovalState as p, useAssignableRoles as r, usePermission as s, Protected as t, useSubject as u, PermissionSet as v, SubjectView as x, PermissionState as y };