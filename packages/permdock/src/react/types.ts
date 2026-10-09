import type { ReactNode } from "react";

import type { Decision } from "../core/decision.ts";
import type { Snapshot, TokenVerifier } from "../core/interfaces.ts";
import type { Permission } from "../core/permissions.ts";

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
} from "../client/types.ts";

export type PermDockProviderProps = (
  | { readonly snapshot: Snapshot | string; readonly snapshotPromise?: never }
  | {
      /**
       * An unawaited snapshot from a Server Component. Hooks never suspend on it: until it
       * resolves they deny with `status: 'pending'`, then re-render. A rejection fails closed
       * (`server-only`). Set `suspend` to suspend readers through `use()` instead.
       */
      readonly snapshotPromise: PromiseLike<Snapshot | string>;
      readonly snapshot?: never;
    }
) & {
  /**
   * With `snapshotPromise`: `true` suspends every hook to the nearest Suspense boundary until it
   * resolves, and a rejection reaches the nearest error boundary. Defaults to `false`.
   */
  readonly suspend?: boolean;
  /**
   * The AuthZEN evaluations endpoint for checks the snapshot cannot answer. `false` never
   * fetches: those checks answer `denied` with reason `server-only`.
   */
  readonly endpoint?: string | false;
  /** Where `refresh()` fetches a fresh snapshot. Defaults to `endpoint`. */
  readonly snapshotUrl?: string;
  readonly approvals?: string;
  readonly tenant?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
  readonly children: ReactNode;
};

export type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
  readonly pending?: ReactNode;
  readonly fallback?: ReactNode | ((decision: Decision) => ReactNode);
  readonly children:
    | ReactNode
    | ((
        decision: Extract<Decision, { readonly outcome: "granted" }>,
      ) => ReactNode);
};
