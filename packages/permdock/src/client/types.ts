import type { Decision } from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { PolicyVocabulary } from "../core/policy.ts";
import type { Actor, Delegation, Principal } from "../core/subject.ts";

export type ClientStatus = "ready" | "pending" | "stale" | "server-only";

export type PermissionState = {
  readonly allowed: boolean;
  readonly status: ClientStatus;
  readonly decision: Decision;
};

export type PermissionSet = {
  readonly granted: readonly Permission[];
  get(permission: Permission): PermissionState | undefined;
};

export type ClientPermDock<V extends PolicyVocabulary = PolicyVocabulary> =
  PermDock<V> & {
    status(permission?: Permission, data?: unknown): ClientStatus;
    invalidate(ref: Permission | { readonly [key: string]: unknown }): void;
    refresh(options?: { readonly tenant?: string }): Promise<void>;
    clear(): void;
    subscribe(listener: () => void): () => void;
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

export type UseRolesOptions = {
  readonly tenant?: string;
  readonly team?: string;
};
