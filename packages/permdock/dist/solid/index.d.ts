import { l as Membership } from "../subject-BcgWbogX.js";
import { A as SnapshotV2, B as Decision, J as Permission, P as TokenVerifier } from "../policy-B9ZJilUm.js";
import { d as describe } from "../permdock-Dzaw5_Cl.js";
import { a as FilterResult, c as PermissionState, d as TenantView, f as UseRolesOptions, i as ClientStatus, n as ApprovalState, p as approvalHeaders, r as ClientPermDock, s as PermissionSet, t as ApprovalHandle, u as SubjectView } from "../types-BkASnC6E.js";
import { Accessor } from "solid-js";
//#region src/solid/types.d.ts
type SolidChild = string | number | boolean | null | undefined;
type PermDockProviderProps = {
  readonly snapshot: SnapshotV2 | string;
  readonly endpoint?: string;
  readonly approvals?: string;
  readonly tenant?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
  readonly children: unknown;
};
type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
  readonly pending?: SolidChild;
  readonly fallback?: SolidChild | ((decision: Decision) => SolidChild);
  readonly children: SolidChild | ((decision: Extract<Decision, {
    readonly outcome: "granted";
  }>) => SolidChild);
};
//#endregion
//#region src/solid/hooks.d.ts
export declare function usePermDock(): ClientPermDock;
export declare function usePermission(permission: Permission, data?: Accessor<unknown>): Accessor<PermissionState>;
export declare function usePermissions(permissions: Accessor<readonly Permission[]>, data?: Accessor<unknown>): Accessor<PermissionSet>;
export declare function useFilter<T>(permission: Permission<string, T, "instance">, rows: Accessor<readonly T[]>): Accessor<FilterResult<T>>;
export declare function useTenant(): Accessor<TenantView>;
export declare function useMemberships(): Accessor<readonly Membership[]>;
export declare function useRoles(options?: Accessor<UseRolesOptions>): Accessor<{
  readonly roles: readonly string[];
}>;
export declare function useAssignableRoles(): Accessor<readonly string[]>;
export declare function useSubject(): Accessor<SubjectView>;
export declare function useApproval(decision: Accessor<Decision>): Accessor<ApprovalHandle>;
//#endregion
//#region src/solid/protected.d.ts
export declare function Protected(props: ProtectedProps): Accessor<SolidChild>;
//#endregion
//#region src/solid/provider.d.ts
export declare function PermDockProvider(props: PermDockProviderProps): unknown;
//#endregion
export { type ApprovalHandle, type ApprovalState, type ClientPermDock, type ClientStatus, type FilterResult, type PermDockProviderProps, type PermissionSet, type PermissionState, type ProtectedProps, type SolidChild, type SubjectView, type TenantView, type UseRolesOptions, approvalHeaders, describe };