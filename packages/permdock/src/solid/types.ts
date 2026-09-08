import type { Accessor } from 'solid-js';

import type { Decision } from '../core/decision.ts';
import type { SnapshotV2, TokenVerifier } from '../core/interfaces.ts';
import type { Permission } from '../core/permissions.ts';
import type {
  ApprovalHandle,
  ApprovalState,
  ClientPermDock,
  ClientStatus,
  FilterResult,
  PermissionSet,
  PermissionState,
  SubjectView,
  TenantView,
  UseRolesOptions,
} from '../react/types.ts';

export type SolidChild = string | number | boolean | null | undefined;

export type PermDockProviderProps = {
  readonly snapshot: SnapshotV2 | string;
  readonly endpoint?: string;
  readonly approvals?: string;
  readonly tenant?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
  readonly children: unknown;
};

export type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
  readonly pending?: SolidChild;
  readonly fallback?: SolidChild | ((decision: Decision) => SolidChild);
  readonly children:
    | SolidChild
    | ((
        decision: Extract<Decision, { readonly outcome: 'granted' }>,
      ) => SolidChild);
};

export type {
  ApprovalHandle,
  ApprovalState,
  ClientPermDock,
  ClientStatus,
  FilterResult,
  PermissionSet,
  PermissionState,
  SubjectView,
  TenantView,
  UseRolesOptions,
};

export type { Accessor };
