import { d as Subject, l as Membership } from "../subject-BcgWbogX.js";
import { B as Decision, J as Permission, X as PermissionTree, o as Policy, v as DecisionProvider } from "../policy-B9ZJilUm.js";
import { m as ArazzoSimulateInput, n as DecideOptions, p as ArazzoPlan, r as PermDock, t as CreatePermDockOptions } from "../permdock-Dzaw5_Cl.js";
//#region src/pdp/types.d.ts
type RemotePdpAuth = {
  readonly bearer: string | (() => string | Promise<string>);
};
type RemotePdpMapping = {
  readonly subject?: (subject: Subject) => {
    readonly type?: string;
    readonly id?: string;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  readonly resource?: (permission: Permission, data: unknown) => {
    readonly type?: string;
    readonly id?: string;
    readonly properties?: unknown;
  };
  readonly action?: (permission: Permission) => {
    readonly name?: string;
  };
};
type RemotePdpEndpoints = {
  readonly evaluation?: string;
  readonly evaluations?: string;
  readonly searchResource?: string;
};
type RemotePdpCache = {
  readonly ttl: number | `${number}s` | `${number}ms`;
};
type RemotePdpOptions = {
  readonly url: string;
  readonly auth?: RemotePdpAuth;
  readonly permissions?: readonly (Permission | PermissionTree)[];
  readonly mapping?: RemotePdpMapping;
  readonly timeout?: number;
  readonly cache?: RemotePdpCache;
  readonly endpoints?: RemotePdpEndpoints;
  readonly fetch?: typeof fetch;
};
type PdpPermDock = Omit<PermDock, "can" | "decide" | "assert" | "filter" | "simulate" | "tenant" | "team"> & {
  readonly can: (permission: Permission, data?: unknown, options?: DecideOptions) => Promise<boolean>;
  readonly decide: (permission: Permission, data?: unknown, options?: DecideOptions) => Promise<Decision>;
  readonly assert: (permission: Permission, data?: unknown, options?: DecideOptions) => Promise<Extract<Decision, {
    readonly outcome: "granted";
  }>>;
  readonly filter: <T>(permission: Permission<string, T, "instance">, rows: readonly T[], options?: DecideOptions) => Promise<T[]>;
  readonly simulate: {
    (checks: readonly (readonly [Permission, unknown?])[]): Promise<readonly Decision[]>;
    (plan: ArazzoSimulateInput): ArazzoPlan;
    (preview: {
      readonly roles?: readonly string[];
      readonly memberships?: readonly Membership[];
      readonly tenant?: string;
    }): PdpPermDock;
  };
  readonly tenant: (id: string) => PdpPermDock;
  readonly team: (id: string) => PdpPermDock;
};
type PdpFactory = (policy: Policy, user: unknown, options?: CreatePermDockOptions) => Promise<PdpPermDock>;
//#endregion
//#region src/pdp/create.d.ts
export declare function createPermDock(policy: Policy, user: unknown, options?: CreatePermDockOptions): Promise<PdpPermDock>;
//#endregion
//#region src/pdp/remote.d.ts
export declare function remotePdp(options: RemotePdpOptions): DecisionProvider;
//#endregion
export type { PdpFactory, PdpPermDock, RemotePdpAuth, RemotePdpCache, RemotePdpEndpoints, RemotePdpMapping, RemotePdpOptions };