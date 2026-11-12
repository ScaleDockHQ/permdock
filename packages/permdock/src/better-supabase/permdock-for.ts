import type { PermissionCheck, PermissionState } from "../core/checks.ts";
import type { InstanceCache } from "../core/instance-cache.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { Intent, MembershipSource } from "../core/interfaces.ts";
import type { PermDock, PermDockOptions } from "../core/permdock.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { SubjectCache } from "../core/subject-cache.ts";
import type { Principal, Subject } from "../core/subject.ts";
import type { SupabaseSessionLike } from "../supabase/types.ts";
import type {
  ApiKeySession,
  BetterSupabaseSubjectOptions,
  SessionSnapshotLike,
} from "./subject.ts";
import type { AnyVersionCache } from "./version-cache.ts";

import { isSubject } from "../core/subject.ts";
import {
  createResolver,
  getPermissions as sharedGetPermissions,
} from "../supabase/resolver.ts";
import { subjectFromBetterSupabase } from "./subject.ts";
import { versionCacheOf } from "./version-cache.ts";

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
  /**
   * The `permdock_subject()` record the bootstrap read in the same round trip.
   * It seeds `subjects` when its user is the session's and its `authzVersion`
   * is `authzVersion`, so the instance reads no `subject_for`.
   */
  readonly subject?: unknown;
  /** The tenant `subject` is restricted to, as `bsb.bootstrap()` reports it. */
  readonly subjectTenant?: string | null;
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
 * The third is the version cache better-supabase passes at runtime, which
 * replaces the `versions` option.
 */
export type PermDockFor<V extends PolicyVocabulary = PolicyVocabulary> = {
  (
    source: PermDockForInput,
    query?: PermDockForQuery | string | null,
    versions?: AnyVersionCache,
  ): Promise<PermDock<V>>;
  /**
   * The instance options every instance of `versions` (default the `versions`
   * option) is built with: the same object on every call, so an adapter that
   * spreads it into its own options, such as oRPC's or MCP's `createPermDock`,
   * shares the `claimsFirst` memberships and the `instances` entries.
   */
  readonly sources: (versions?: AnyVersionCache) => InstanceOptions;
};

export type PermDockForOptions<V extends PolicyVocabulary = PolicyVocabulary> =
  {
    readonly policy: Policy<unknown, Principal, V>;
    /** How the verified claims map to a subject. */
    readonly subject?: BetterSupabaseSubjectOptions;
    /**
     * The membership source a stale token is re-read from, wrapped in
     * `claimsFirst(source, { onStale: 'reread', versions })`.
     */
    readonly memberships?: MembershipSource | readonly MembershipSource[];
    /**
     * The version `claimsFirst` compares with `authz_ver`; default the
     * source's.
     */
    readonly version?: MembershipSource["version"];
    /** The process-wide version cache (`createNext({ versions })`). */
    readonly versions?: AnyVersionCache;
    /** The process-wide instance cache, shared with the app's other adapters. */
    readonly instances?: InstanceCache;
    /**
     * The `subjects` cache of the app's `postgrestSources`. A call that knows
     * the user's authorization version (a `bootstrap` or `getAccess` result)
     * tells it that version, which drops a record older than it.
     */
    readonly subjects?: SubjectCache;
    /** Sources and sinks for each instance. */
    readonly options?: Omit<PermDockOptions, "tenant" | "intent" | "version">;
  };

/** `permdockFor` with the version cache better-supabase passes at runtime. */
export type PermDockResolver<V extends PolicyVocabulary = PolicyVocabulary> = {
  (
    source: PermDockForInput,
    query: PermDockForQuery,
    versions?: AnyVersionCache,
  ): Promise<PermDock<V>>;
  readonly sources: (versions?: AnyVersionCache) => InstanceOptions;
};

/** The options a `permdockFor` resolver already holds. */
const RESOLVER_OWNS = [
  "subject",
  "memberships",
  "version",
  "versions",
  "instances",
  "subjects",
  "options",
] as const;

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

function permdockResolver<V extends PolicyVocabulary>(
  given: PermDockForOptions<V>,
): PermDockResolver<V> {
  const { subject, ...rest } = given;
  return createResolver<V, PermDockForInput, AnyVersionCache>({
    ...rest,
    subjectOf: (source, result, signedOut) =>
      subjectOf(
        source,
        // SAFETY: a better-supabase access result carries a better-supabase session.
        result as PermDockForResult | undefined,
        signedOut,
        subject,
      ),
    versionCacheOf,
  });
}

/**
 * The resolver an adapter builds instances with: the app's `permdockFor`, or
 * one built from the adapter's own options. `permdockFor` with any option it
 * already holds throws a `TypeError`, since two sources of the same option
 * would disagree.
 */
export function resolverOf<V extends PolicyVocabulary>(
  options: PermDockForOptions<V> & { readonly permdockFor?: PermDockFor<V> },
  adapter: string,
): PermDockResolver<V> {
  const shared = options.permdockFor;
  if (shared === undefined) return permdockResolver(options);
  const clash = RESOLVER_OWNS.find((key) => options[key] !== undefined);
  if (clash !== undefined) {
    throw new TypeError(
      `PermDock: ${adapter} takes ${clash} from permdockFor; pass it to permdockFor instead`,
    );
  }
  const resolve = (
    source: PermDockForInput,
    query: PermDockForQuery,
    versions?: AnyVersionCache,
  ): Promise<PermDock<V>> => shared(source, query, versions);
  return Object.freeze(Object.assign(resolve, { sources: shared.sources }));
}

/**
 * One resolver for every instance of the app: `permdockFor(await
 * bsb.claims())`, `permdockFor(await bsb.bootstrap(...))` or `permdockFor(await
 * bsb.getAccess(...))`. A bootstrap or access result passes its `authzVersion`
 * as `version.known`, so the instance reads no version, and a `sessionActive:
 * false` bootstrap is anonymous. With `instances`, a subject at an unchanged
 * version reuses its instance across requests. Pass the same resolver to
 * `authorizer({ permdockFor })`, `authorizationHooks({ permdockFor })` and,
 * through `permdockFor.sources()`, to every other adapter's options, so they
 * share one instance per subject and version.
 */
export function permdockFor<V extends PolicyVocabulary = PolicyVocabulary>(
  options: PermDockForOptions<V>,
): PermDockFor<V> {
  const resolve = permdockResolver(options);
  const call = (
    source: PermDockForInput,
    query?: PermDockForQuery | string | null,
    versions?: AnyVersionCache,
  ): Promise<PermDock<V>> =>
    resolve(
      source,
      typeof query === "string" || query === null
        ? { tenant: query }
        : (query ?? {}),
      versions,
    );
  return Object.freeze(Object.assign(call, { sources: resolve.sources }));
}

/** `getPermissions` over `permdockFor` input. */
export function getPermissions<K extends string>(
  resolve: (
    source: PermDockForInput,
    query?: PermDockForQuery | string | null,
  ) => Promise<PermDock>,
  input: PermDockForInput,
  checks: Readonly<Record<K, PermissionCheck>>,
  query?: PermDockForQuery | string | null,
): Promise<Readonly<Record<K, PermissionState>>> {
  return sharedGetPermissions(resolve, input, checks, query);
}
