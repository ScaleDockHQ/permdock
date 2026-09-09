import { d as Subject } from "../subject-BcgWbogX.js";
import { J as PermissionTree, K as Permission, R as Decision, o as Policy, v as DecisionProvider } from "../policy-DdqgAkJT.js";
import { n as DecideOptions, r as PermDock, t as CreatePermDockOptions } from "../permdock-CaK4qAlv.js";
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
    (preview: Parameters<PermDock["simulate"]>[0] & object): PdpPermDock;
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