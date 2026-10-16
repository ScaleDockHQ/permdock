import type { ReactNode } from "react";

import type { ClientStoreOptions } from "../client/store.ts";
import type {
  ApprovalRequiredDecision,
  Decision,
  GrantedDecision,
} from "../core/decision.ts";
import type { DescribeMessages } from "../core/describe.ts";
import type { TokenVerifier } from "../core/interfaces.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Snapshot } from "../core/snapshot-types.ts";

export type {
  ApprovalHandle,
  ApprovalState,
  ClientPermDock,
  ClientStatus,
  FilterResult,
  GateMode,
  GateView,
  PermissionSet,
  PermissionState,
  SubjectView,
  TenantView,
  RolesOptions,
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
  /** What every `<Protected>` below renders for a slot it leaves out. */
  readonly defaults?: PermDockDefaults;
  /** Localised text for `useDescribe()`. */
  readonly messages?: DescribeMessages;
  /** Called with each snapshot the store accepts; the latest prop is called. */
  readonly onSnapshot?: NonNullable<ClientStoreOptions["onSnapshot"]>;
  /** Called when the store drops its snapshot; the latest prop is called. */
  readonly onClear?: () => void;
  /** Milliseconds between approval status polls. Defaults to 2000. */
  readonly approvalInterval?: number;
  readonly children: ReactNode;
};

/** Provider-wide content for the `<Protected>` slots a component leaves out. */
export type PermDockDefaults = {
  readonly pending?: ReactNode;
  readonly denied?: ReactNode | ((decision: Decision) => ReactNode);
  readonly approval?:
    | ReactNode
    | ((decision: ApprovalRequiredDecision) => ReactNode);
};

export type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
  readonly pending?: ReactNode;
  readonly denied?: ReactNode | ((decision: Decision) => ReactNode);
  /** Rendered for an approval-required decision; defaults to `denied`. */
  readonly approval?:
    | ReactNode
    | ((decision: ApprovalRequiredDecision) => ReactNode);
  readonly children: ReactNode | ((decision: GrantedDecision) => ReactNode);
};
