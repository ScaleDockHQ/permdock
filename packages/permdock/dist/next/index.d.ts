import { l as SnapshotSource, o as MembershipSource, r as DecisionSink, s as RoleSource } from "../interfaces-CnUn1fRe.js";
import { s as ApprovalStore } from "../types-DzwcM0QE.js";
import { T as Permission, n as Decision, p as Policy } from "../decision-B2jL7xrt.js";
import { r as PermDock } from "../permdock-DN6lGjHN.js";
import { ReactElement, ReactNode } from "react";
//#region src/next/types.d.ts
type NextSubjectInput = unknown;
type NextPermDockOptions<TUser = NextSubjectInput> = {
  readonly subject: () => TUser | Promise<TUser>;
  readonly tenant?: string | (() => string | undefined | Promise<string | undefined>);
  readonly tag?: (user: TUser, tenant: string | undefined) => string;
  readonly onDenied?: (decision: Decision) => never | void;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly endpoint?: string;
};
type GetPermDockQuery = {
  readonly tenant?: string;
};
type ServerPermissionState = {
  readonly allowed: boolean;
  readonly status: "ready";
  readonly decision: Decision;
};
type ServerPermDockProviderProps = {
  readonly children: ReactNode;
  readonly tenant?: string;
  readonly include?: readonly (Permission | {
    readonly [key: string]: unknown;
  })[];
  readonly tenants?: "all";
  readonly endpoint?: string;
};
type PermDockHandler = {
  readonly POST: (request: Request) => Promise<Response>;
  readonly GET: (request: Request) => Promise<Response>;
};
type NextPermDock = {
  readonly getPermDock: (query?: GetPermDockQuery) => Promise<PermDock>;
  readonly getPermission: (permission: Permission, data?: unknown) => Promise<ServerPermissionState>;
  readonly PermDockProvider: (props: ServerPermDockProviderProps) => Promise<ReactElement>;
  readonly permdockHandler: () => PermDockHandler;
};
//#endregion
//#region src/next/create.d.ts
export declare function createPermDock(policy: Policy, options: NextPermDockOptions): NextPermDock;
//#endregion
export type { GetPermDockQuery, NextPermDock, NextPermDockOptions, PermDockHandler, ServerPermDockProviderProps, ServerPermissionState };