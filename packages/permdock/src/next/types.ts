import type { ReactElement, ReactNode } from 'react';

import type { ApprovalStore } from '../approvals/types.ts';
import type { Decision } from '../core/decision.ts';
import type { PolicySource } from '../core/hosted.ts';
import type {
  DecisionSink,
  LimitStore,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { PolicyVocabulary } from '../core/policy.ts';
import type { OtelOptions } from '../otel/types.ts';

export type NextSubjectInput = unknown;

export type NextPermDockOptions<TUser = NextSubjectInput> = {
  readonly subject: () => TUser | Promise<TUser>;
  readonly tenant?:
    | string
    | (() => string | undefined | Promise<string | undefined>);
  readonly onDenied?: (decision: Decision) => never | void;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  /** Hosted grants, read once per instance; see `PolicySource`. */
  readonly policies?: PolicySource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly limits?: LimitStore;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
  readonly endpoint?: string;
};

export type GetPermDockQuery = {
  readonly tenant?: string;
};

export type RequireAccessInput = {
  readonly permission: Permission;
  /** The row for an instance permission; omit it for a collection permission. */
  readonly data?: unknown;
  /** The active tenant, as for `getPermDock({ tenant })`; defaults to the factory's `tenant`. */
  readonly tenant?: string;
};

export type ServerPermissionState = {
  readonly allowed: boolean;
  readonly status: 'ready';
  readonly decision: Decision;
};

export type ServerPermDockProviderProps = {
  readonly children: ReactNode;
  readonly tenant?: string;
  readonly include?: readonly (
    | Permission
    | { readonly [key: string]: unknown }
  )[];
  readonly tenants?: 'all';
  readonly endpoint?: string;
};

export type PermDockHandler = {
  readonly POST: (request: Request) => Promise<Response>;
  readonly GET: (request: Request) => Promise<Response>;
};

export type NextPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly getPermDock: (query?: GetPermDockQuery) => Promise<PermDock<V>>;
  readonly getPermission: (
    permission: Permission,
    data?: unknown,
  ) => Promise<ServerPermissionState>;
  /**
   * Resolves to the granted `Decision`. A denial calls `unauthorized()` for an
   * anonymous subject and `forbidden()` otherwise (`experimental.authInterrupts`);
   * approval-required and boundary validation throw as from `assert`.
   */
  readonly requireAccess: (
    input: RequireAccessInput,
  ) => Promise<Extract<Decision, { readonly outcome: 'granted' }>>;
  /** Never awaits: passes an unawaited snapshot to the client provider, whose hooks suspend. */
  readonly PermDockProvider: (
    props: ServerPermDockProviderProps,
  ) => ReactElement;
  readonly permdockHandler: () => PermDockHandler;
};
