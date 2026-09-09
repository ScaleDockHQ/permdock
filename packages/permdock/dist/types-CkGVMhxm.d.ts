import { o as Delegation, t as Actor, u as Principal } from "./subject-BcgWbogX.js";
import { r as Permission } from "./permissions-CkmCCiYs.js";
import { n as Decision } from "./decision-CH_azeep.js";
import { f as SnapshotV2, g as TokenVerifier } from "./interfaces-BPpihPRB.js";
import { r as PermDock } from "./permdock-BHYt07KR.js";
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
export { FilterResult as a, PermissionState as c, TenantView as d, UseRolesOptions as f, ClientStatus as i, ProtectedProps as l, ApprovalState as n, PermDockProviderProps as o, approvalHeaders as p, ClientPermDock as r, PermissionSet as s, ApprovalHandle as t, SubjectView as u };