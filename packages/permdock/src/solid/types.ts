import type { Accessor } from "solid-js";

import type { PermissionBoundaryState } from "../client/boundary.ts";
import type {
  ApprovalHandle,
  ApprovalState,
  ClientPermDock,
  ClientStatus,
  FilterResult,
  GateMode,
  GateView,
  PermissionSet,
  PermissionState,
  ProviderOptionsBase,
  SubjectView,
  TenantView,
  RolesOptions,
} from "../client/types.ts";
import type {
  ApprovalRequiredDecision,
  Decision,
  GrantedDecision,
} from "../core/decision.ts";
import type { TokenVerifier } from "../core/interfaces.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Snapshot } from "../core/snapshot-types.ts";

/** Structural `JSX.Element`: text, a DOM node or a list of children. */
export type SolidChild =
  | string
  | number
  | boolean
  | null
  | undefined
  | { readonly nodeType: number }
  | readonly SolidChild[];

export type PermDockProviderProps = ProviderOptionsBase & {
  /**
   * An accessor re-hydrates the store when it changes and keeps it `pending`
   * while it returns `undefined` (a loading `createResource`); a promise keeps
   * the store `pending` until it settles.
   */
  readonly snapshot:
    | Snapshot
    | string
    | Accessor<Snapshot | string | undefined>
    | PromiseLike<Snapshot | string>;
  /** A change switches the active tenant (`refresh({ tenant })`). */
  readonly tenant?: string;
  /**
   * Read on every request, with `verifier`, so a rotated token applies without
   * a new store.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly verifier?: TokenVerifier;
  /** What every `<Protected>` below renders for a slot it leaves out. */
  readonly defaults?: PermDockDefaults;
  readonly children: unknown;
};

/** Provider-wide content for the `<Protected>` slots a component leaves out. */
export type PermDockDefaults = {
  readonly pending?: SolidChild;
  readonly denied?: SolidChild | ((decision: Decision) => SolidChild);
  readonly approval?:
    | SolidChild
    | ((decision: ApprovalRequiredDecision) => SolidChild);
};

export type PermissionBoundaryProps = {
  /** Rendered in place of the children when one throws `PermDockDeniedError`. */
  readonly denied?:
    | SolidChild
    | ((state: PermissionBoundaryState) => SolidChild);
  /** Rendered for `PermDockApprovalRequiredError`; defaults to `denied`. */
  readonly approval?:
    | SolidChild
    | ((state: PermissionBoundaryState) => SolidChild);
  readonly children: unknown;
};

export type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
  readonly pending?: SolidChild;
  readonly denied?: SolidChild | ((decision: Decision) => SolidChild);
  /** Rendered for an approval-required decision; defaults to `denied`. */
  readonly approval?:
    | SolidChild
    | ((decision: ApprovalRequiredDecision) => SolidChild);
  readonly children: SolidChild | ((decision: GrantedDecision) => SolidChild);
};

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
};

export type { Accessor, PermissionBoundaryState };
