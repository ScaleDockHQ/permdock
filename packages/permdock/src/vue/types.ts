import type { MaybeRefOrGetter, VNode } from "vue";

import type { ClientStoreOptions } from "../client/store.ts";
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
} from "../client/types.ts";
import type { ApprovalRequiredDecision, Decision } from "../core/decision.ts";
import type { DescribeMessages } from "../core/describe.ts";
import type { Snapshot, TokenVerifier } from "../core/interfaces.ts";

export type PermDockPluginOptions = {
  /**
   * A ref or getter re-hydrates the store when it changes; a promise keeps
   * the store `pending` until it settles (await the same promise in an async
   * `setup` under `<Suspense>`).
   */
  readonly snapshot:
    | MaybeRefOrGetter<Snapshot | string>
    | PromiseLike<Snapshot | string>;
  /**
   * The AuthZEN evaluations endpoint for checks the snapshot cannot answer.
   * `false` never calls one: such a check is denied with reason `server-only`.
   */
  readonly endpoint?: string | false;
  /** Where `refresh()` fetches a fresh snapshot. Defaults to `endpoint`. */
  readonly snapshotUrl?: string;
  readonly approvals?: string;
  /** A ref or getter switches the active tenant (`refresh({ tenant })`) when it changes. */
  readonly tenant?: MaybeRefOrGetter<string | undefined>;
  readonly fetch?: typeof fetch;
  /** Read on every request: a ref or getter carries a rotated token without rebuilding the store. */
  readonly headers?: MaybeRefOrGetter<
    Readonly<Record<string, string>> | undefined
  >;
  readonly maxAge?: number;
  /** Read on every verification; set it at install to verify signed snapshots. */
  readonly verifier?: MaybeRefOrGetter<TokenVerifier | undefined>;
  /** What every `<Protected>` renders for a slot it leaves out. */
  readonly defaults?: PermDockDefaults;
  /** Localised text for `useDescribe()`. */
  readonly messages?: DescribeMessages;
  /** Called with each snapshot the store accepts. */
  readonly onSnapshot?: NonNullable<ClientStoreOptions["onSnapshot"]>;
  /** Called when the store drops its snapshot. */
  readonly onClear?: () => void;
  /** Milliseconds between approval status polls. Defaults to 2000. */
  readonly approvalInterval?: number;
};

type SlotOutput = VNode | VNode[] | string | null;

/** Render functions for the `<Protected>` slots a component leaves out; they get the slot props. */
export type PermDockDefaults = {
  readonly pending?: () => SlotOutput;
  readonly fallback?: (props: { readonly decision: Decision }) => SlotOutput;
  readonly approval?: (props: {
    readonly decision: ApprovalRequiredDecision;
  }) => SlotOutput;
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
