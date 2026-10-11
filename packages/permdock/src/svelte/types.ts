import type { Snippet } from "svelte";
import type { Readable } from "svelte/store";

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
  UseRolesOptions,
} from "../client/types.ts";
import type { ApprovalRequiredDecision, Decision } from "../core/decision.ts";
import type { TokenVerifier } from "../core/interfaces.ts";
import type { Snapshot } from "../core/snapshot-types.ts";

export type PermDockSvelteOptions = ProviderOptionsBase & {
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
  /** A getter (`() => page.params.org`) switches the active tenant (`refresh({ tenant })`) when it changes. */
  readonly tenant?: string | (() => string | undefined);
  /** A getter is read on every request, so a rotated token applies without a new store. */
  readonly headers?:
    | Readonly<Record<string, string>>
    | (() => Readonly<Record<string, string>> | undefined);
  readonly verifier?: TokenVerifier;
  /** What every `<Protected>` renders for a snippet it leaves out. */
  readonly defaults?: PermDockDefaults;
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
