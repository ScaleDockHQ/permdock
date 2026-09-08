import { m as Membership } from "./ast-BtUySn6K.js";
import { v as Permission } from "./policy-CL40bNGn.js";
import { n as Decision } from "./decision-Cjr-7xoX.js";
import { a as FilterResult, c as PermissionState, d as TenantView, f as UseRolesOptions, l as ProtectedProps, r as ClientPermDock, s as PermissionSet, t as ApprovalHandle, u as SubjectView } from "./types-CyfFrnpu.js";
import { ReactNode } from "react";
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
export { useMemberships as a, usePermissions as c, useTenant as d, useFilter as i, useRoles as l, useApproval as n, usePermDock as o, useAssignableRoles as r, usePermission as s, Protected as t, useSubject as u };