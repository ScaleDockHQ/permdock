import type { ReactElement, ReactNode } from "react";

import type { ApprovalStore } from "../approvals/types.ts";
import type { Decision, DenialReason } from "../core/decision.ts";
import type { DescribeMessages } from "../core/describe.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { PolicyVocabulary } from "../core/policy-types.ts";
import type { Snapshot } from "../core/snapshot-types.ts";
import type { Subject } from "../core/subject.ts";
import type { PermDockWrap } from "../core/wrap.ts";
import type { OtelWrap } from "../otel/types.ts";

// oxlint-disable-next-line anti-slop/no-unknown-type-aliases -- public alias; the resolver parses it
export type NextSubjectInput = unknown;

export type NextPermDockOptions<TUser = NextSubjectInput> = InstanceOptions & {
  /** The user, or a full `Subject` (core then skips `policy.subject`). */
  readonly subject: () => TUser | Subject | Promise<TUser | Subject>;
  readonly tenant?:
    | string
    | (() => string | undefined | Promise<string | undefined>);
  readonly onDenied?: (decision: Decision) => never | void;
  readonly store?: ApprovalStore;
  /** `(permdock) => withOtel(permdock, options)` from `permdock/otel`. */
  readonly otel?: OtelWrap;
  /** Wraps each instance after `otel`; build it with `wrapPermDock` to cover derived instances. */
  readonly wrap?: PermDockWrap;
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

export type GetSnapshotQuery = GetPermDockQuery & {
  readonly include?: readonly (
    | Permission
    | { readonly [key: string]: unknown }
  )[];
  readonly tenants?: "all";
  /** Tags added next to `snapshotTag(sub)`, such as the app's own organisation tag. */
  readonly tags?: readonly string[];
};

export type PermissionRequirementOptions = GetPermDockQuery & {
  /**
   * Runs before the default interrupts; throw or redirect to replace them.
   * Defaults to the factory's `onDenied`.
   */
  readonly onDenied?: (decision: Decision) => never | void;
};

export type ServerPermissionState = {
  readonly allowed: boolean;
  readonly status: "ready";
  readonly decision: Decision;
};

export type NextPermDockProviderProps = {
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
  /**
   * What every `<Protected>` below renders for a slot it leaves out. Nodes
   * only: a function cannot cross from a Server Component to the client.
   */
  readonly defaults?: {
    readonly pending?: ReactNode;
    readonly denied?: ReactNode;
    readonly approval?: ReactNode;
  };
  /** Localised text for `useDescribe()`; records only, for the same reason. */
  readonly messages?: Pick<DescribeMessages, "titles" | "separator"> & {
    readonly reasons?: Partial<Record<DenialReason, string>>;
  };
};

export type PermDockHandler = {
  readonly POST: (request: Request) => Promise<Response>;
  readonly GET: (request: Request) => Promise<Response>;
};

export type NextPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly getPermDock: (query?: GetPermDockQuery) => Promise<PermDock<V>>;
  /**
   * `{ allowed, status: 'ready', decision }`. Any failure to build the
   * instance denies; Next.js interrupts (`redirect()`, `notFound()`,
   * request-time bailouts) from `subject` or `tenant` pass through.
   */
  readonly getPermission: (
    permission: Permission,
    data?: unknown,
    query?: GetPermDockQuery,
  ) => Promise<ServerPermissionState>;
  /**
   * The session's snapshot for a `'use cache: private'` function the app owns:
   * calls `cacheLife(cacheLifeFor(snapshot))` and `cacheTag(snapshotTag(sub), ...tags)`
   * in that scope, and throws outside one.
   */
  readonly getSnapshot: (query?: GetSnapshotQuery) => Promise<Snapshot>;
  /**
   * Resolves to the granted `Decision`. A denial first runs `onDenied` (the
   * call's, else the factory's), then calls `unauthorized()` for an anonymous
   * subject and `forbidden()` otherwise (`experimental.authInterrupts`);
   * approval-required and boundary validation throw as from `assert`.
   */
  readonly requirePermission: (
    permission: Permission,
    data?: unknown,
    options?: PermissionRequirementOptions,
  ) => Promise<Extract<Decision, { readonly outcome: "granted" }>>;
  /** Never awaits: passes an unawaited snapshot to the client provider, whose hooks suspend. */
  readonly PermDockProvider: (props: NextPermDockProviderProps) => ReactElement;
  readonly permdockHandler: () => PermDockHandler;
};
