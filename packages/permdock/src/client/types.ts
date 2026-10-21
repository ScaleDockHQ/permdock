import type { Decision } from "../core/decision.ts";
import type { DecisionDescription } from "../core/describe.ts";
import type { DescribeMessages } from "../core/describe.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { PolicyVocabulary } from "../core/policy-types.ts";
import type { Actor, Delegation, Principal } from "../core/subject.ts";
import type { RefreshTrigger } from "./refresh-on.ts";
import type { ClientStoreOptions } from "./store.ts";

export type ClientStatus = "ready" | "pending" | "stale" | "server-only";

export type PermissionState = {
  readonly allowed: boolean;
  readonly status: ClientStatus;
  readonly decision: Decision;
};

export type PermissionSet = {
  readonly granted: readonly Permission[];
  get: (permission: Permission) => PermissionState | undefined;
};

export type ClientPermDock<V extends PolicyVocabulary = PolicyVocabulary> =
  PermDock<V> & {
    status: (permission?: Permission, data?: unknown) => ClientStatus;
    invalidate: (ref: Permission | { readonly [key: string]: unknown }) => void;
    refresh: (options?: { readonly tenant?: string }) => Promise<void>;
    clear: () => void;
    subscribe: (listener: () => void) => () => void;
  };

export type ApprovalState =
  | "not-needed"
  | "required"
  | "pending"
  | "approved"
  | "rejected"
  | "expired";

export type ApprovalHandle = {
  readonly state: ApprovalState;
  readonly token: string | undefined;
  readonly request: (note?: string) => Promise<void>;
};

export type SubjectView = {
  readonly principal: Principal | null;
  readonly actor: Actor | undefined;
  readonly delegation: Delegation | undefined;
  readonly expiresAt: number | undefined;
  readonly simulated: boolean;
};

export type TenantView = {
  readonly tenant: string | null;
  readonly tenants: readonly string[];
  readonly switchTo: (id: string) => Promise<void>;
  readonly status: ClientStatus;
};

export type FilterResult<T> = readonly T[] & { readonly partial: boolean };

/**
 * Which held roles `useRoles` lists: those of a tenant (the active one by
 * default), or only those on the memberships of one `scope`, and of one
 * instance `id` of it.
 */
export type RolesOptions = {
  readonly tenant?: string;
  readonly scope?: string;
  readonly id?: string;
};

/**
 * The provider options Vue, Svelte and Solid share; each adds its own reactive
 * `snapshot`, `tenant`, `headers`, `verifier` and `defaults`.
 */
export type ProviderOptionsBase = {
  /**
   * The AuthZEN evaluations endpoint for checks the snapshot cannot answer.
   * `false` never calls one: such a check is denied with reason `server-only`.
   */
  readonly endpoint?: string | false;
  /** Where `refresh()` fetches a fresh snapshot. Defaults to `endpoint`. */
  readonly snapshotUrl?: string;
  readonly approvals?: string;
  /** Read on every request, so a new `fetch` applies without a new store. */
  readonly fetch?: typeof fetch;
  readonly maxAge?: number;
  /** Localised text for the describe helper. */
  readonly messages?: DescribeMessages;
  /** Called with each snapshot the store accepts. */
  readonly onSnapshot?: NonNullable<ClientStoreOptions["onSnapshot"]>;
  /** Called when the store drops its snapshot. */
  readonly onClear?: () => void;
  /** Milliseconds between approval status polls. Defaults to 2000. */
  readonly approvalInterval?: number;
  /**
   * Triggers that refresh the snapshot, such as `eventSourceRefresh(url)`; read
   * once.
   */
  readonly refreshOn?: readonly RefreshTrigger[];
};

/**
 * How a control shows a permission it cannot use: hidden, or disabled with a
 * reason.
 */
export type GateMode = "hide" | "disable";

/**
 * Everything a permission-gated control renders from, in one value: a button, a
 * menu item or a link reads these fields and decides nothing itself. The client
 * is a hint; the server checks again.
 */
export type GateView = {
  /** The decision granted the action. */
  readonly allowed: boolean;
  /** The snapshot is loading; render the control disabled, not hidden. */
  readonly pending: boolean;
  /** `mode: "hide"` and the action is not available: render nothing. */
  readonly hidden: boolean;
  /**
   * The control cannot run the action now (denied, pending or awaiting
   * approval).
   */
  readonly disabled: boolean;
  /** The decision needs a person's approval first; offer to request it. */
  readonly needsApproval: boolean;
  /**
   * The plans that would grant the action, for an upgrade prompt; empty
   * otherwise.
   */
  readonly upgrade: readonly string[];
  /** Title and detail for a tooltip or an accessible description. */
  readonly reason: DecisionDescription;
  readonly decision: Decision;
};
