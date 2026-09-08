import { m as Membership } from "../ast-BtUySn6K.js";
import { v as Permission } from "../policy-CL40bNGn.js";
import { n as Decision } from "../decision-Cjr-7xoX.js";
import { m as TokenVerifier, u as SnapshotV2 } from "../interfaces-DMSVa7et.js";
import { d as describe } from "../permdock-CSDl61mA.js";
import { a as FilterResult, c as PermissionState, d as TenantView, f as UseRolesOptions, i as ClientStatus, n as ApprovalState, p as approvalHeaders, r as ClientPermDock, s as PermissionSet, t as ApprovalHandle, u as SubjectView } from "../types-BCXRAyFb.js";
import { ComputedRef, DefineComponent, MaybeRefOrGetter, Plugin } from "vue";
//#region src/vue/types.d.ts
type PermDockPluginOptions = {
  readonly snapshot: SnapshotV2 | string;
  readonly endpoint?: string;
  readonly approvals?: string;
  readonly tenant?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
};
//#endregion
//#region src/vue/composables.d.ts
export declare function usePermDock(): ClientPermDock;
export declare function usePermission(permission: Permission, data?: MaybeRefOrGetter<unknown>): {
  readonly allowed: ComputedRef<boolean>;
  readonly status: ComputedRef<PermissionState["status"]>;
  readonly decision: ComputedRef<Decision>;
};
export declare function usePermissions(permissions: MaybeRefOrGetter<readonly Permission[]>, data?: MaybeRefOrGetter<unknown>): ComputedRef<PermissionSet>;
export declare function useFilter<T>(permission: Permission<string, T, "instance">, rows: MaybeRefOrGetter<readonly T[]>): ComputedRef<FilterResult<T>>;
export declare function useTenant(): ComputedRef<TenantView>;
export declare function useMemberships(): ComputedRef<readonly Membership[]>;
export declare function useRoles(options?: MaybeRefOrGetter<UseRolesOptions>): ComputedRef<{
  readonly roles: readonly string[];
}>;
export declare function useAssignableRoles(): ComputedRef<readonly string[]>;
export declare function useSubject(): ComputedRef<SubjectView>;
export declare function useApproval(decision: MaybeRefOrGetter<Decision>): ComputedRef<ApprovalHandle>;
//#endregion
//#region src/vue/plugin.d.ts
export declare const permdockPlugin: Plugin<PermDockPluginOptions>;
//#endregion
//#region src/vue/protected.d.ts
type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
};
export declare const Protected: DefineComponent<ProtectedProps>;
//#endregion
export { type ApprovalHandle, type ApprovalState, type ClientPermDock, type ClientStatus, type FilterResult, type PermDockPluginOptions, type PermissionSet, type PermissionState, type SubjectView, type TenantView, type UseRolesOptions, approvalHeaders, describe };