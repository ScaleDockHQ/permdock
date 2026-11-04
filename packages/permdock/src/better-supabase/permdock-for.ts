import type { PermissionCheck, PermissionState } from "../core/checks.ts";
import type { Decision } from "../core/decision.ts";
import type { InstanceCache } from "../core/instance-cache.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { Intent, MembershipSource } from "../core/interfaces.ts";
import type { PermDock, PermDockOptions } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { SubjectCache } from "../core/subject-cache.ts";
import type { Principal, Subject } from "../core/subject.ts";
import type { VersionCache } from "../core/version-cache.ts";
import type { SupabaseSessionLike } from "../supabase/types.ts";
import type {
  ApiKeySession,
  BetterSupabaseSubjectOptions,
  SessionSnapshotLike,
} from "./subject.ts";

import { appOf } from "../core/app.ts";
import { buildInstance } from "../core/build-instance.ts";
import { permissionStates } from "../core/checks.ts";
import { compact, isRecord } from "../core/compact.ts";
import { NO_GRANT } from "../core/decision.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { isSubject } from "../core/subject.ts";
import { versionSources } from "../core/version-sources.ts";
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
 * The third is the version cache better-supabase passes at runtime, which
 * replaces the `versions` option.
 */
export type PermDockFor<V extends PolicyVocabulary = PolicyVocabulary> = {
  (
    source: PermDockForInput,
    query?: PermDockForQuery | string | null,
    versions?: VersionCache,
  ): Promise<PermDock<V>>;
  /**
   * The instance options every instance of `versions` (default the `versions`
   * option) is built with: the same object on every call, so an adapter that
   * spreads it into its own options, such as oRPC's or MCP's `createPermDock`,
   * shares the `claimsFirst` memberships and the `instances` entries.
   */
  readonly sources: (versions?: VersionCache) => InstanceOptions;
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
    readonly versions?: VersionCache;
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
    versions?: VersionCache,
  ): Promise<PermDock<V>>;
  readonly sources: (versions?: VersionCache) => InstanceOptions;
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
 * `options` with the `definePermDock` definition of its policy under it:
 * `memberships`, `instances`, `versions` and `subjects` by key, and the other
 * sources and `settings` inside `options.options`. A plain policy changes
 * nothing.
 */
function withDefinition<V extends PolicyVocabulary>(
  options: PermDockForOptions<V>,
): PermDockForOptions<V> {
  const app = appOf(options.policy);
  if (app === undefined) return options;
  const { memberships, instances, ...sources } = instanceOptions(app);
  return {
    ...options,
    ...compact({
      memberships: options.memberships ?? memberships,
      instances: options.instances ?? instances,
      versions: options.versions ?? app.versions,
      subjects: options.subjects ?? app.subjects,
    }),
    options: {
      ...sources,
      ...compact({ settings: app.settings }),
      ...options.options,
    },
  };
}

/**
 * The resolver behind `permdockFor`, the authorizer and the hooks: one sources
 * object per version cache, so every instance of one subject at one version
 * shares an `instances` entry.
 */
function permdockResolver<V extends PolicyVocabulary>(
  given: PermDockForOptions<V>,
): PermDockResolver<V> {
  const options = withDefinition(given);
  const sourcesFor = versionSources(options);
  const resolve = async (
    source: PermDockForInput,
    query: PermDockForQuery,
    runtimeVersions?: VersionCache,
  ): Promise<PermDock<V>> => {
    const result = isResult(source) ? source : undefined;
    const signedOut = result?.sessionActive === false;
    const user = subjectOf(source, result, signedOut, options.subject);
    const tenant = query.tenant ?? result?.tenant ?? undefined;
    const known = signedOut ? undefined : knownVersion(result?.authzVersion);
    const sources = sourcesFor(runtimeVersions);
    const id = user.principal?.id;
    if (
      options.subjects !== undefined &&
      id !== undefined &&
      known !== undefined
    ) {
      try {
        await options.subjects.record(id, known);
      } catch {
        // A cache that fails answers nothing; the source reads the record itself.
      }
    }
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
  return Object.freeze(Object.assign(resolve, { sources: sourcesFor }));
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
    versions?: VersionCache,
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
    versions?: VersionCache,
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

/**
 * One `{ allowed, outcome, reason? }` per named check for `input`, from one
 * `permdockFor` instance: frozen plain JSON an island returns from `'use cache:
 * private'`. A check that throws denies its entry; an instance that cannot be
 * built denies them all.
 */
export async function getPermissions<K extends string>(
  resolve: (
    source: PermDockForInput,
    query?: PermDockForQuery | string | null,
  ) => Promise<PermDock>,
  input: PermDockForInput,
  checks: Readonly<Record<K, PermissionCheck>>,
  query?: PermDockForQuery | string | null,
): Promise<Readonly<Record<K, PermissionState>>> {
  let permdock: PermDock | undefined;
  try {
    permdock = await resolve(input, query);
  } catch {
    permdock = undefined;
  }
  if (permdock === undefined) {
    return permissionStates((): Decision => NO_GRANT, checks);
  }
  // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
  const decide = permdock.decide as (
    next: Permission,
    row?: unknown,
  ) => Decision;
  return permissionStates(decide, checks);
}
