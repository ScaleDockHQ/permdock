import type { ReactElement, ReactNode } from 'react';

import type { ApprovalStore } from '../approvals/types.ts';
import type { Decision } from '../core/decision.ts';
import type {
  DecisionSink,
  MembershipSource,
  RoleSource,
  SnapshotSource,
} from '../core/interfaces.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { OtelOptions } from '../otel/types.ts';

export type NextSubjectInput = unknown;

export type NextPermDockOptions<TUser = NextSubjectInput> = {
  readonly subject: () => TUser | Promise<TUser>;
  readonly tenant?:
    | string
    | (() => string | undefined | Promise<string | undefined>);
  readonly tag?: (user: TUser, tenant: string | undefined) => string;
  readonly onDenied?: (decision: Decision) => never | void;
  readonly memberships?: MembershipSource;
  readonly customRoles?: RoleSource;
  readonly store?: ApprovalStore;
  readonly sink?: DecisionSink;
  readonly snapshots?: SnapshotSource;
  readonly otel?: OtelOptions;
  readonly endpoint?: string;
};

export type GetPermDockQuery = {
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

export type NextPermDock = {
  readonly getPermDock: (query?: GetPermDockQuery) => Promise<PermDock>;
  readonly getPermission: (
    permission: Permission,
    data?: unknown,
  ) => Promise<ServerPermissionState>;
  readonly PermDockProvider: (
    props: ServerPermDockProviderProps,
  ) => Promise<ReactElement>;
  readonly permdockHandler: () => PermDockHandler;
};
