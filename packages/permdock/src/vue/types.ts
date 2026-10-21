import type { MaybeRefOrGetter, VNode } from "vue";

import type {
  ApprovalHandle,
  ApprovalState,
  ClientPermDock,
  ClientStatus,
  FilterResult,
  PermissionSet,
  PermissionState,
  ProviderOptionsBase,
  SubjectView,
  TenantView,
  RolesOptions,
} from "../client/types.ts";
import type { ApprovalRequiredDecision, Decision } from "../core/decision.ts";
import type { TokenVerifier } from "../core/interfaces.ts";
import type { Snapshot } from "../core/snapshot-types.ts";

export type PermDockPluginOptions = ProviderOptionsBase & {
  /**
   * A ref or getter re-hydrates the store when it changes; a promise keeps the
   * store `pending` until it settles (await the same promise in an async
   * `setup` under `<Suspense>`).
   */
  readonly snapshot:
    | MaybeRefOrGetter<Snapshot | string>
    | PromiseLike<Snapshot | string>;
  /**
   * A ref or getter switches the active tenant (`refresh({ tenant })`) when it
   * changes.
   */
  readonly tenant?: MaybeRefOrGetter<string | undefined>;
  /**
   * Read on every request: a ref or getter carries a rotated token without
   * rebuilding the store.
   */
  readonly headers?: MaybeRefOrGetter<
    Readonly<Record<string, string>> | undefined
  >;
  /** Read on every verification; set it at install to verify signed snapshots. */
  readonly verifier?: MaybeRefOrGetter<TokenVerifier | undefined>;
  /** What every `<Protected>` renders for a slot it leaves out. */
  readonly defaults?: PermDockDefaults;
};

type SlotOutput = VNode | VNode[] | string | null;

/**
 * Render functions for the `<Protected>` slots a component leaves out; they get
 * the slot props.
 */
export type PermDockDefaults = {
  readonly pending?: () => SlotOutput;
  readonly denied?: (props: { readonly decision: Decision }) => SlotOutput;
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
  RolesOptions,
};
