import type { ArazzoPlan, ArazzoSimulateInput } from '../core/arazzo.ts';
import type { Decision } from '../core/decision.ts';
import type { DecisionProvider } from '../core/interfaces.ts';
import type {
  CreatePermDockOptions,
  DecideOptions,
  PermDock,
  WhereResult,
} from '../core/permdock.ts';
import type { Permission, PermissionTree } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { Principal } from '../core/subject.ts';
import type { Membership, Subject } from '../core/subject.ts';

export type RemotePdpAuth = {
  readonly bearer: string | (() => string | Promise<string>);
};

export type RemotePdpMapping = {
  readonly subject?: (subject: Subject) => {
    readonly type?: string;
    readonly id?: string;
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  readonly resource?: (
    permission: Permission,
    data: unknown,
  ) => {
    readonly type?: string;
    readonly id?: string;
    readonly properties?: unknown;
  };
  readonly action?: (permission: Permission) => { readonly name?: string };
};

export type RemotePdpEndpoints = {
  readonly evaluation?: string;
  readonly evaluations?: string;
  readonly searchResource?: string;
};

export type RemotePdpCache = {
  readonly ttl: number | `${number}s` | `${number}ms`;
};

export type RemotePdpOptions = {
  readonly url: string;
  readonly auth?: RemotePdpAuth;
  readonly permissions?: readonly (Permission | PermissionTree)[];
  readonly mapping?: RemotePdpMapping;
  readonly timeout?: number;
  readonly cache?: RemotePdpCache;
  readonly endpoints?: RemotePdpEndpoints;
  readonly fetch?: typeof fetch;
};

/**
 * One tuple callback per delegated permission. The callback receives the
 * row for a check and `undefined` for a listing; returning `null` denies
 * with `pdp-denied`, throwing denies with `pdp-invalid-response`.
 */
export type RelationMap<T> = readonly (readonly [
  Permission,
  (subject: Subject, data: unknown) => T | null,
])[];

export type OpenFgaTuple = {
  /** `user:anne`, `team:eng#member`. */
  readonly user: string;
  readonly relation: string;
  readonly type: string;
  /** Required for a check; ignored for `list-objects`. */
  readonly id?: string;
};

export type OpenFgaOptions = {
  readonly url: string;
  readonly storeId: string;
  readonly authorizationModelId?: string;
  readonly map: RelationMap<OpenFgaTuple>;
  readonly auth?: RemotePdpAuth;
  readonly timeout?: number;
  readonly cache?: RemotePdpCache;
  readonly fetch?: typeof fetch;
};

export type SpiceDbCheck = {
  readonly subject: {
    readonly type: string;
    readonly id: string;
    readonly relation?: string;
  };
  readonly permission: string;
  /** `id` is required for a check; ignored for `LookupResources`. */
  readonly resource: { readonly type: string; readonly id?: string };
};

export type SpiceDbOptions = {
  /** The SpiceDB HTTP gateway origin. */
  readonly url: string;
  readonly token: RemotePdpAuth['bearer'];
  readonly map: RelationMap<SpiceDbCheck>;
  readonly consistency?: 'minimize-latency' | 'fully-consistent';
  readonly timeout?: number;
  readonly cache?: RemotePdpCache;
  readonly fetch?: typeof fetch;
};

export type PdpPermDock = Omit<
  PermDock,
  | 'can'
  | 'decide'
  | 'assert'
  | 'filter'
  | 'where'
  | 'simulate'
  | 'tenant'
  | 'team'
> & {
  /**
   * For a delegated permission whose provider lists ids, an `in` over them
   * (AND the local condition when local grants exist); otherwise the local
   * `where`, or an always-false `partial` result.
   */
  readonly where: (permission: Permission) => Promise<WhereResult>;
  readonly can: (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ) => Promise<boolean>;
  readonly decide: (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ) => Promise<Decision>;
  readonly assert: (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ) => Promise<Extract<Decision, { readonly outcome: 'granted' }>>;
  readonly filter: <T>(
    permission: Permission<string, T, 'instance'>,
    rows: readonly T[],
    options?: DecideOptions,
  ) => Promise<T[]>;
  readonly simulate: {
    (
      checks: readonly (readonly [Permission, unknown?])[],
    ): Promise<readonly Decision[]>;
    (plan: ArazzoSimulateInput): ArazzoPlan;
    (preview: {
      readonly roles?: readonly (string | { readonly key: string })[];
      readonly memberships?: readonly Membership[];
      readonly tenant?: string;
    }): PdpPermDock;
  };
  readonly tenant: (id: string) => PdpPermDock;
  readonly team: (id: string) => PdpPermDock;
};

export type PdpFactory = <TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  user: TUser | null,
  options?: CreatePermDockOptions,
) => Promise<PdpPermDock>;

export type { DecisionProvider };
