import { l as Membership } from "../subject-BcgWbogX.js";
import { v as Permission } from "../policy-DsqYfECx.js";
import { n as Decision } from "../decision-C6A-71_M.js";
import { f as SnapshotV2, g as TokenVerifier } from "../interfaces-B19qT0zU.js";
import { d as describe } from "../permdock-BFyP-l5_.js";
import { a as FilterResult, c as PermissionState, d as TenantView, f as UseRolesOptions, i as ClientStatus, n as ApprovalState, p as approvalHeaders, r as ClientPermDock, s as PermissionSet, t as ApprovalHandle, u as SubjectView } from "../types-DN9PS-Hn.js";
import "../store-CMuVRAjj.js";
import { Component, Snippet } from "svelte";
import { Readable } from "svelte/store";
//#region src/svelte/types.d.ts
type PermDockSvelteOptions = {
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
//#region src/svelte/protected.d.ts
type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
  readonly children?: Snippet<[Decision]>;
  readonly pending?: Snippet;
  readonly fallback?: Snippet<[Decision]>;
};
//#endregion
//#region src/svelte/stores.d.ts
export declare function setPermDock(options: PermDockSvelteOptions): ClientPermDock;
export declare function getPermDock(): ClientPermDock;
export declare function permission(reference: Permission, data?: () => unknown): Readable<PermissionState>;
export declare function permissions(references: () => readonly Permission[], data?: () => unknown): Readable<PermissionSet>;
export declare function filtered<T>(reference: Permission<string, T, "instance">, rows: () => readonly T[]): Readable<FilterResult<T>>;
export declare function tenant(): Readable<TenantView>;
export declare function memberships(): Readable<readonly Membership[]>;
export declare function roles(options?: () => UseRolesOptions): Readable<{
  readonly roles: readonly string[];
}>;
export declare function assignable(): Readable<readonly string[]>;
export declare function subject(): Readable<SubjectView>;
export declare function approval(decision: () => Decision): Readable<ApprovalHandle>;
//#endregion
//#region src/svelte/index.d.ts
export declare const Protected: Component<ProtectedProps>;
//#endregion
export { type ApprovalHandle, type ApprovalState, type ClientPermDock, type ClientStatus, type FilterResult, type PermDockSvelteOptions, type PermissionSet, type PermissionState, type ProtectedProps, type SubjectView, type TenantView, type UseRolesOptions, approvalHeaders, describe };