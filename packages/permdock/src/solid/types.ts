import type { Accessor } from "solid-js";

import type { PermissionBoundaryState } from "../client/boundary.ts";
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
import type { Decision } from "../core/decision.ts";
import type { Snapshot, TokenVerifier } from "../core/interfaces.ts";
import type { Permission } from "../core/permissions.ts";

/** Structural `JSX.Element`: text, a DOM node or a list of children. */
export type SolidChild =
  | string
  | number
  | boolean
  | null
  | undefined
  | { readonly nodeType: number }
  | readonly SolidChild[];

export type PermDockProviderProps = {
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
  /**
   * The AuthZEN evaluations endpoint for checks the snapshot cannot answer.
   * `false` never calls one: such a check is denied with reason `server-only`.
   */
  readonly endpoint?: string | false;
  /** Where `refresh()` fetches a fresh snapshot. Defaults to `endpoint`. */
  readonly snapshotUrl?: string;
  readonly approvals?: string;
  /** A change switches the active tenant (`refresh({ tenant })`). */
  readonly tenant?: string;
  /** `headers`, `fetch` and `verifier` are read on every request, so a rotated token applies without a new store. */
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
  readonly children: unknown;
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
  readonly fallback?: SolidChild | ((decision: Decision) => SolidChild);
  readonly children:
    | SolidChild
    | ((
        decision: Extract<Decision, { readonly outcome: "granted" }>,
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

export type { Accessor, PermissionBoundaryState };
