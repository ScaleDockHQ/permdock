import type { Readable } from "svelte/store";

import type { Snapshot, TokenVerifier } from "../core/interfaces.ts";
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
} from "../react/types.ts";

export type PermDockSvelteOptions = {
  /**
   * A getter (`() => data.snapshot`) or a readable store re-hydrates the
   * store when it changes; a promise keeps the store `pending` until it
   * settles (render the same promise with `{#await}`).
   */
  readonly snapshot:
    | Snapshot
    | string
    | (() => Snapshot | string)
    | Readable<Snapshot | string>
    | PromiseLike<Snapshot | string>;
  readonly endpoint?: string;
  /** Where `refresh()` fetches a fresh snapshot. Defaults to `endpoint`. */
  readonly snapshotUrl?: string;
  readonly approvals?: string;
  readonly tenant?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
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
