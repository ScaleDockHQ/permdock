import type { ReactElement, ReactNode } from "react";

import type { ApprovalStore } from "../approvals/types.ts";
import type { Decision } from "../core/decision.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { SnapshotSource } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { PolicyVocabulary } from "../core/policy.ts";
import type { OtelWrap } from "../otel/types.ts";

// oxlint-disable-next-line anti-slop/no-unknown-type-aliases -- public alias; the resolver parses it
export type NextSubjectInput = unknown;

export type NextPermDockOptions<TUser = NextSubjectInput> = InstanceOptions & {
  readonly subject: () => TUser | Promise<TUser>;
  readonly tenant?:
    | string
    | (() => string | undefined | Promise<string | undefined>);
  readonly onDenied?: (decision: Decision) => never | void;
  readonly store?: ApprovalStore;
  /** @deprecated Not read by any adapter. */
  readonly snapshots?: SnapshotSource;
  /** `(permdock) => withOtel(permdock, options)` from `permdock/otel`. */
  readonly otel?: OtelWrap;
  /**
   * Where `PermDockProvider` sends checks the snapshot cannot answer; default `/api/permdock`.
   * `false` is snapshot-only: no `permdockHandler` route, and those checks are denied with
   * reason `server-only`.
   */
  readonly endpoint?: string | false;
};

export type GetPermDockQuery = {
  readonly tenant?: string;
};

export type RequireAccessInput = {
  readonly permission: Permission;
  /** The row for an instance permission; omit it for a collection permission. */
  readonly data?: unknown;
  /** The active tenant, as for `getPermDock({ tenant })`; defaults to the factory's `tenant`. */
  readonly tenant?: string;
};

export type ServerPermissionState = {
  readonly allowed: boolean;
  readonly status: "ready";
  readonly decision: Decision;
};

export type ServerPermDockProviderProps = {
  readonly children: ReactNode;
  readonly tenant?: string;
  readonly include?: readonly (
    | Permission
    | { readonly [key: string]: unknown }
  )[];
  readonly tenants?: "all";
  /** Overrides the factory's `endpoint`; `false` is snapshot-only. */
  readonly endpoint?: string | false;
  /** Suspends permission readers until the snapshot streams in, instead of answering `pending`. */
  readonly suspend?: boolean;
};

export type PermDockHandler = {
  readonly POST: (request: Request) => Promise<Response>;
  readonly GET: (request: Request) => Promise<Response>;
};

export type NextPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly getPermDock: (query?: GetPermDockQuery) => Promise<PermDock<V>>;
  readonly getPermission: (
    permission: Permission,
    data?: unknown,
  ) => Promise<ServerPermissionState>;
  /**
   * Resolves to the granted `Decision`. A denial calls `unauthorized()` for an
   * anonymous subject and `forbidden()` otherwise (`experimental.authInterrupts`);
   * approval-required and boundary validation throw as from `assert`.
   */
  readonly requireAccess: (
    input: RequireAccessInput,
  ) => Promise<Extract<Decision, { readonly outcome: "granted" }>>;
  /** Never awaits: passes an unawaited snapshot to the client provider, whose hooks suspend. */
  readonly PermDockProvider: (
    props: ServerPermDockProviderProps,
  ) => ReactElement;
  readonly permdockHandler: () => PermDockHandler;
};
