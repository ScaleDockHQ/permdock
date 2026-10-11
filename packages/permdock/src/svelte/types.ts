import type { Snippet } from "svelte";
import type { Readable } from "svelte/store";

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
  /**
   * The AuthZEN evaluations endpoint for checks the snapshot cannot answer.
   * `false` never calls one: such a check is denied with reason `server-only`.
   */
  readonly endpoint?: string | false;
  /** Where `refresh()` fetches a fresh snapshot. Defaults to `endpoint`. */
  readonly snapshotUrl?: string;
  readonly approvals?: string;
  /** A getter (`() => page.params.org`) switches the active tenant (`refresh({ tenant })`) when it changes. */
  readonly tenant?: string | (() => string | undefined);
  readonly fetch?: typeof fetch;
  /** A getter is read on every request, so a rotated token applies without a new store. */
  readonly headers?:
    | Readonly<Record<string, string>>
    | (() => Readonly<Record<string, string>> | undefined);
  readonly maxAge?: number;
  readonly verifier?: TokenVerifier;
  /** What every `<Protected>` renders for a snippet it leaves out. */
  readonly defaults?: PermDockDefaults;
  /** Localised text for `getDescribe()`. */
  readonly messages?: DescribeMessages;
  /** Called with each snapshot the store accepts. */
  readonly onSnapshot?: NonNullable<ClientStoreOptions["onSnapshot"]>;
  /** Called when the store drops its snapshot. */
  readonly onClear?: () => void;
  /** Milliseconds between approval status polls. Defaults to 2000. */
  readonly approvalInterval?: number;
};

/** Snippets for the `<Protected>` slots a component leaves out. */
export type PermDockDefaults = {
  readonly pending?: Snippet;
  readonly fallback?: Snippet<[Decision]>;
  readonly approval?: Snippet<[ApprovalRequiredDecision]>;
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
