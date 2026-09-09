import type { Decision } from '../core/decision.ts';
import type { DecisionProvider } from '../core/interfaces.ts';
import type {
  CreatePermDockOptions,
  DecideOptions,
  PermDock,
} from '../core/permdock.ts';
import type { Permission, PermissionTree } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type { Subject } from '../core/subject.ts';

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

export type PdpPermDock = Omit<
  PermDock,
  'can' | 'decide' | 'assert' | 'filter' | 'simulate' | 'tenant' | 'team'
> & {
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
    (preview: Parameters<PermDock['simulate']>[0] & object): PdpPermDock;
  };
  readonly tenant: (id: string) => PdpPermDock;
  readonly team: (id: string) => PdpPermDock;
};

export type PdpFactory = (
  policy: Policy,
  user: unknown,
  options?: CreatePermDockOptions,
) => Promise<PdpPermDock>;

export type { DecisionProvider };
