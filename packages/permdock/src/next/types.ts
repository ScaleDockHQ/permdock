import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ReactElement, ReactNode } from "react";

import type { ApprovalStore } from "../approvals/types.ts";
import type { ActionResult, ProtectedAction } from "../core/action-result.ts";
import type { PermissionCheck, PermissionState } from "../core/checks.ts";
import type { Decision, DenialReason } from "../core/decision.ts";
import type { DescribeMessages } from "../core/describe.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { Intent } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { RowData, UncheckedData } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { PolicyVocabulary } from "../core/policy-types.ts";
import type { CacheLifeForOptions } from "../core/snapshot-cache.ts";
import type { Snapshot, SnapshotTenants } from "../core/snapshot-types.ts";
import type { Subject } from "../core/subject.ts";
import type { PermDockWrap } from "../core/wrap.ts";
import type { OtelWrap } from "../otel/types.ts";
import type { PermDockProviderProps } from "../react/types.ts";

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
  /**
   * Wraps each instance after `otel`; build it with `wrapPermDock` to cover
   * derived instances.
   */
  readonly wrap?: PermDockWrap;
  /**
   * Where `PermDockProvider` sends checks the snapshot cannot answer; default
   * `/api/permdock`. `false` is snapshot-only: no `permdockHandler` route, and
   * those checks are denied with reason `server-only`.
   */
  readonly endpoint?: string | false;
  /**
   * The principal's authorization version this request already read, such as
   * `bsb.bootstrap()`'s `authzVersion`. Called once per request; a read-intent
   * instance takes it as `version: { known }` and skips the version read. A
   * write-intent instance, `protectAction` included, reads the version live.
   * Anything but a non-negative integer, or a throw, reads it as usual.
   */
  readonly version?: () =>
    | number
    | null
    | undefined
    | Promise<number | null | undefined>;
};

export type GetPermDockQuery = {
  readonly tenant?: string;
  /**
   * Default `'read'`: with `claimsFirst(…, { versions })` the token may be
   * judged from the shared version cache, at most its `maxStaleMs` stale. Pass
   * `'write'` before a mutation outside `protectAction`, which always reads the
   * version live.
   */
  readonly intent?: Intent;
  /**
   * The known authorization version for this call, in place of the `version`
   * option. Read intent only.
   */
  readonly version?: number;
};

export type GetSnapshotQuery = GetPermDockQuery & {
  readonly include?: readonly (
    | Permission
    | { readonly [key: string]: unknown }
  )[];
  readonly tenants?: SnapshotTenants;
  /**
   * Tags added next to `snapshotTag(sub)`, such as the app's own organisation
   * tag.
   */
  readonly tags?: readonly string[];
  /**
   * `cacheLifeFor` options; `{ capToToken: true }` caps the entry at the
   * token's expiry. Default 300 seconds.
   */
  readonly cacheLife?: CacheLifeForOptions;
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

export type NextPermDockProviderProps = NextPermDockProviderDisplay &
  (
    | {
        /**
         * The snapshot to hand to the client, usually from the app's `'use
         * cache: private'` loader around `getSnapshot`, so a prefetch carries
         * it. The loader decides what it includes.
         */
        readonly snapshot: Promise<Snapshot>;
        readonly include?: never;
        readonly tenants?: never;
      }
    | {
        /** Without `snapshot`, the provider builds one outside any cache. */
        readonly snapshot?: undefined;
        readonly include?: readonly (
          | Permission
          | { readonly [key: string]: unknown }
        )[];
        readonly tenants?: SnapshotTenants;
      }
  );

/**
 * Function props of the React provider: a Server Component cannot pass them to
 * the client, so `useRefreshOn` from `permdock/react` adds triggers instead.
 */
type ClientOnlyProp =
  | "fetch"
  | "verifier"
  | "onSnapshot"
  | "onClear"
  | "refreshOn";

type NextPermDockProviderDisplay = Omit<
  PermDockProviderProps,
  | "snapshot"
  | "snapshotPromise"
  | "children"
  | "defaults"
  | "messages"
  | ClientOnlyProp
> & {
  readonly children: ReactNode;
  readonly tenant?: string;
  /** Overrides the factory's `endpoint`; `false` is snapshot-only. */
  readonly endpoint?: string | false;
  /**
   * Suspends permission readers until the snapshot streams in, instead of
   * answering `pending`.
   */
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

export type ProtectActionOptions<TInput, TRow> = {
  /** Validates the action's argument before anything else runs. */
  readonly input: StandardSchemaV1<unknown, TInput>;
  /** The row to decide on; `null` or `undefined` answers `404`. */
  readonly data?: (
    input: TInput,
  ) => TRow | null | undefined | Promise<TRow | null | undefined>;
  /** The tenant to build the instance for; default the factory's `tenant`. */
  readonly tenant?: (input: TInput) => string | undefined;
};

export type ProtectedActionContext<TRow, V extends PolicyVocabulary> = {
  readonly permdock: PermDock<V>;
  readonly decision: Extract<Decision, { readonly outcome: "granted" }>;
  /** The loaded row; `undefined` without a `data` loader. */
  readonly data: TRow;
};

export type ProtectedActionHandler<
  TInput,
  TRow,
  TResult,
  V extends PolicyVocabulary,
> = (
  input: TInput,
  context: ProtectedActionContext<TRow, V>,
) => TResult | Promise<TResult>;

export type { ActionResult, ProtectedAction };

export type ProtectAction<V extends PolicyVocabulary> = <
  TInput,
  TRow = undefined,
>(
  permission: Permission,
  options: ProtectActionOptions<TInput, TRow>,
) => <TResult>(
  handler: ProtectedActionHandler<TInput, TRow, TResult, V>,
) => ProtectedAction<Awaited<TResult>>;

export type NextPermDock<V extends PolicyVocabulary = PolicyVocabulary> = {
  readonly getPermDock: (query?: GetPermDockQuery) => Promise<PermDock<V>>;
  /**
   * `{ allowed, status: 'ready', decision }`. Any failure to build the instance
   * denies; Next.js interrupts (`redirect()`, `notFound()`, request-time
   * bailouts) from `subject` or `tenant` pass through.
   */
  readonly getPermission: {
    <D>(
      permission: Permission,
      data?: UncheckedData<D>,
      query?: GetPermDockQuery,
    ): Promise<ServerPermissionState>;
    <P extends Permission>(
      permission: P,
      data?: RowData<P>,
      query?: GetPermDockQuery,
    ): Promise<ServerPermissionState>;
  };
  /**
   * One `{ allowed, outcome, reason? }` per named check, from one instance:
   * frozen plain JSON an island can return from `'use cache: private'`. A check
   * that throws denies its entry; an instance that cannot be built denies them
   * all.
   */
  readonly getPermissions: <K extends string>(
    checks: Readonly<Record<K, PermissionCheck>>,
    query?: GetPermDockQuery,
  ) => Promise<Readonly<Record<K, PermissionState>>>;
  /**
   * The session's snapshot for a `'use cache: private'` function the app owns:
   * calls `cacheLife(cacheLifeFor(snapshot, query.cacheLife))` and
   * `cacheTag(snapshotTag(sub), ...tags)` in that scope, and throws outside
   * one.
   */
  readonly getSnapshot: (query?: GetSnapshotQuery) => Promise<Snapshot>;
  /**
   * Resolves to the granted `Decision`. A denial first runs `onDenied` (the
   * call's, else the factory's), then calls `unauthorized()` for an anonymous
   * subject and `forbidden()` otherwise (`experimental.authInterrupts`);
   * approval-required and boundary validation throw as from `assert`.
   */
  readonly requirePermission: {
    <D>(
      permission: Permission,
      data?: UncheckedData<D>,
      options?: PermissionRequirementOptions,
    ): Promise<Extract<Decision, { readonly outcome: "granted" }>>;
    <P extends Permission>(
      permission: P,
      data?: RowData<P>,
      options?: PermissionRequirementOptions,
    ): Promise<Extract<Decision, { readonly outcome: "granted" }>>;
  };
  /**
   * Never awaits: passes an unawaited snapshot to the client provider, whose
   * hooks suspend.
   */
  readonly PermDockProvider: (props: NextPermDockProviderProps) => ReactElement;
  readonly permdockHandler: () => PermDockHandler;
  /**
   * Wraps a server action: validates `input`, loads `data`, decides, then runs
   * the handler. Resolves to `{ ok: true, value }` or `{ ok: false, problem }`
   * with RFC 9457 Problem Details; only Next.js interrupts throw.
   */
  readonly protectAction: ProtectAction<V>;
};
