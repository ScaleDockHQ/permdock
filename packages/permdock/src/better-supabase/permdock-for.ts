import type { InstanceCache } from "../core/instance-cache.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { Intent, MembershipSource } from "../core/interfaces.ts";
import type { PermDock, PermDockOptions } from "../core/permdock.ts";
import type { Policy } from "../core/policy-types.ts";
import type { Subject } from "../core/subject.ts";
import type { VersionCache } from "../core/version-cache.ts";
import type { SupabaseSessionLike } from "../supabase/types.ts";
import type {
  ApiKeySession,
  BetterSupabaseSubjectOptions,
  SessionSnapshotLike,
} from "./subject.ts";

import { buildInstance } from "../core/build-instance.ts";
import { isRecord } from "../core/compact.ts";
import { claimsFirst } from "../core/memberships.ts";
import { isSubject } from "../core/subject.ts";
import { subjectFromBetterSupabase } from "./subject.ts";

/**
 * What `bsb.bootstrap()` and `bsb.getAccess()` return: a session with the
 * tenant and the authorization version read in the same request.
 */
export type PermDockForResult = {
  readonly session: SupabaseSessionLike | ApiKeySession | null;
  readonly tenant: string | null;
  readonly authzVersion: number | null;
  /** `bsb.bootstrap()`'s `session_active()`; `false` is signed out. */
  readonly sessionActive?: boolean;
};

/** Who an instance is for. */
export type PermDockForInput =
  | SupabaseSessionLike
  | ApiKeySession
  | SessionSnapshotLike
  | PermDockForResult
  | Subject
  | null
  | undefined;

export type PermDockForQuery = {
  /** Default the source's tenant (`bootstrap`, `getAccess`). */
  readonly tenant?: string | null;
  /** Default `read`. */
  readonly intent?: Intent;
};

/**
 * The instance for a session, a `bsb.bootstrap()` result, a `bsb.getAccess()`
 * result or a subject. The second argument is a query or a tenant, so it also
 * serves as an approvals handler's or access-review handler's `permdockFor`.
 */
export type PermDockFor = (
  source: PermDockForInput,
  query?: PermDockForQuery | string | null,
) => Promise<PermDock>;

export type PermDockForOptions = {
  readonly policy: Policy;
  /** How the verified claims map to a subject. */
  readonly subject?: BetterSupabaseSubjectOptions;
  /**
   * The membership source a stale token is re-read from, wrapped in
   * `claimsFirst(source, { onStale: 'reread', versions })`.
   */
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  /** The version `claimsFirst` compares with `authz_ver`; default the source's. */
  readonly version?: MembershipSource["version"];
  /** The process-wide version cache (`createNext({ versions })`). */
  readonly versions?: VersionCache;
  /** The process-wide instance cache, shared with the app's other adapters. */
  readonly instances?: InstanceCache;
  /** Sources and sinks for each instance. */
  readonly options?: Omit<PermDockOptions, "tenant" | "intent" | "version">;
};

/** `permdockFor` with the version cache better-supabase passes at runtime. */
export type PermDockResolver = (
  source: PermDockForInput,
  query: PermDockForQuery,
  versions?: VersionCache,
) => Promise<PermDock>;

function isResult(source: unknown): source is PermDockForResult {
  return (
    isRecord(source) &&
    Object.hasOwn(source, "session") &&
    Object.hasOwn(source, "authzVersion") &&
    !Object.hasOwn(source, "kind")
  );
}

function knownVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function subjectOf(
  source: PermDockForInput,
  result: PermDockForResult | undefined,
  signedOut: boolean,
  options: BetterSupabaseSubjectOptions | undefined,
): Subject {
  if (isSubject(source)) return source;
  if (result !== undefined) {
    return subjectFromBetterSupabase(
      signedOut ? null : result.session,
      options,
    );
  }
  // SAFETY: a source that is neither a subject nor a result is a session, a snapshot or absent.
  const session = source as Exclude<
    PermDockForInput,
    PermDockForResult | Subject
  >;
  return subjectFromBetterSupabase(session, options);
}

/**
 * The resolver behind `permdockFor`, the authorizer and the hooks: one sources
 * object per version cache, so every instance of one subject at one version
 * shares an `instances` entry.
 */
export function permdockResolver(
  options: PermDockForOptions,
): PermDockResolver {
  const byCache = new WeakMap<VersionCache, InstanceOptions>();
  let uncached: InstanceOptions | undefined;
  const sourcesOf = (versions: VersionCache | undefined): InstanceOptions => ({
    ...options.options,
    ...(options.instances === undefined
      ? {}
      : { instances: options.instances }),
    ...(options.memberships === undefined
      ? {}
      : {
          memberships: claimsFirst(options.memberships, {
            onStale: "reread",
            ...(options.version === undefined
              ? {}
              : { version: options.version }),
            ...(versions === undefined ? {} : { versions }),
          }),
        }),
  });
  const sourcesFor = (versions: VersionCache | undefined): InstanceOptions => {
    if (versions === undefined) {
      uncached ??= sourcesOf(undefined);
      return uncached;
    }
    const known = byCache.get(versions);
    if (known !== undefined) return known;
    const created = sourcesOf(versions);
    byCache.set(versions, created);
    return created;
  };
  return async (source, query, runtimeVersions) => {
    const result = isResult(source) ? source : undefined;
    const signedOut = result?.sessionActive === false;
    const user = subjectOf(source, result, signedOut, options.subject);
    const tenant = query.tenant ?? result?.tenant ?? undefined;
    const known = signedOut ? undefined : knownVersion(result?.authzVersion);
    const sources = sourcesFor(runtimeVersions ?? options.versions);
    const { permdock } = await buildInstance({
      policy: options.policy,
      user,
      sources,
      scope: {
        ...options.options,
        memberships: sources.memberships,
        intent: query.intent ?? "read",
        tenant: tenant ?? undefined,
        version: known === undefined ? undefined : { known },
      },
    });
    return permdock;
  };
}

/**
 * One resolver for every instance of the app: `permdockFor(await
 * bsb.claims())`, `permdockFor(await bsb.bootstrap(...))` or `permdockFor(await
 * bsb.getAccess(...))`. A bootstrap or access result passes its `authzVersion`
 * as `version.known`, so the instance reads no version, and a `sessionActive:
 * false` bootstrap is anonymous. With `instances`, a subject at an unchanged
 * version reuses its instance across requests.
 */
export function permdockFor(options: PermDockForOptions): PermDockFor {
  const resolve = permdockResolver(options);
  return (source, query) =>
    resolve(
      source,
      typeof query === "string" || query === null
        ? { tenant: query }
        : (query ?? {}),
    );
}
