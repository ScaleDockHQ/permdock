import type { ReactNode } from "react";

import type { ClientStoreOptions } from "../client/store.ts";
import type {
  ApprovalRequiredDecision,
  Decision,
  GrantedDecision,
} from "../core/decision.ts";
import type { DescribeMessages } from "../core/describe.ts";
import type { TokenVerifier } from "../core/interfaces.ts";
import type { RowData } from "../core/permdock.ts";
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
  ProtectedActionHandle,
  ProtectedActionView,
  SubjectView,
  TenantView,
  RolesOptions,
} from "../client/types.ts";

export type PermDockProviderProps = (
  | { readonly snapshot: Snapshot | string; readonly snapshotPromise?: never }
  | {
      /**
       * An unawaited snapshot from a Server Component. Hooks never suspend on
       * it: until it resolves they deny with `status: 'pending'`, then
       * re-render. A rejection fails closed (`server-only`). Set `suspend` to
       * suspend readers through `use()` instead.
       */
      readonly snapshotPromise: PromiseLike<Snapshot | string>;
      readonly snapshot?: never;
    }
) & {
  /**
   * With `snapshotPromise`: `true` suspends every hook to the nearest Suspense
   * boundary until it resolves, and a rejection reaches the nearest error
   * boundary. Defaults to `false`.
   */
  readonly suspend?: boolean;
  /**
   * The AuthZEN evaluations endpoint for checks the snapshot cannot answer.
   * `false` never fetches: those checks answer `denied` with reason
   * `server-only`.
   */
  readonly endpoint?: string | false;
  /** Where `refresh()` fetches a fresh snapshot. Defaults to `endpoint`. */
  readonly snapshotUrl?: string;
  /**
   * Answers `refresh()` in place of a request to `snapshotUrl` or `endpoint`;
   * see `ClientStoreOptions.fetchSnapshot`.
   */
  readonly fetchSnapshot?: NonNullable<ClientStoreOptions["fetchSnapshot"]>;
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
  /**
   * Triggers that refresh the snapshot, such as `eventSourceRefresh(url)`; read
   * when the store is built.
   */
  readonly refreshOn?: ClientStoreOptions["refreshOn"];
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

export type ProtectedProps<P extends Permission = Permission> = {
  readonly permission: P;
  /** Any part of the permission's row; see `RowData`. */
  readonly data?: RowData<P>;
  readonly tenant?: string;
  readonly pending?: ReactNode;
  readonly denied?: ReactNode | ((decision: Decision) => ReactNode);
  /** Rendered for an approval-required decision; defaults to `denied`. */
  readonly approval?:
    | ReactNode
    | ((decision: ApprovalRequiredDecision) => ReactNode);
  readonly children: ReactNode | ((decision: GrantedDecision) => ReactNode);
};
