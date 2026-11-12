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

import { appOf } from "../core/app.ts";
import { buildInstance } from "../core/build-instance.ts";
import { permissionStates } from "../core/checks.ts";
import { compact, isRecord } from "../core/compact.ts";
import { NO_GRANT } from "../core/decision.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { readSubjectRecord } from "../core/subject-cache.ts";
import { versionSources } from "../core/version-sources.ts";

/**
 * A session with the tenant and the authorization version read in the same
 * request, as a Supabase bootstrap answers it.
 */
export type SupabaseAccessResult = {
  readonly session: unknown;
  readonly tenant: string | null;
  readonly authzVersion: number | null;
  /** `false` is signed out. */
  readonly sessionActive?: boolean;
  /**
   * The `permdock_subject()` record read in the same round trip. It seeds
   * `subjects` when its user is the session's and its `authzVersion` is
   * `authzVersion`, so the instance reads no `subject_for`.
   */
  readonly subject?: unknown;
  /**
   * The tenant `subject` is restricted to; `null` or absent when it covers
   * every tenant. A subject for another tenant than the one checked is not
   * seeded.
   */
  readonly subjectTenant?: string | null;
};

export type ResolverQuery = {
  readonly tenant?: string | null;
  readonly intent?: Intent;
};

export type ResolverOptions<V extends PolicyVocabulary, TSource, TVersions> = {
  readonly policy: Policy<unknown, Principal, V>;
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  readonly version?: MembershipSource["version"];
  readonly versions?: TVersions;
  readonly instances?: InstanceCache;
  readonly subjects?: SubjectCache;
  readonly options?: Omit<PermDockOptions, "tenant" | "intent" | "version">;
  /** The subject of `source`; `result` is set when `source` is an access result. */
  readonly subjectOf: (
    source: TSource,
    result: SupabaseAccessResult | undefined,
    signedOut: boolean,
  ) => Subject;
  /** The PermDock cache behind whatever cache shape the caller holds. */
  readonly versionCacheOf: (
    cache: TVersions | undefined,
  ) => VersionCache | undefined;
};

export type Resolver<V extends PolicyVocabulary, TSource, TVersions> = {
  (
    source: TSource,
    query: ResolverQuery,
    versions?: TVersions,
  ): Promise<PermDock<V>>;
  readonly sources: (versions?: TVersions) => InstanceOptions;
};

function isAccessResult(source: unknown): source is SupabaseAccessResult {
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

/**
 * `options` with the `definePermDock` definition of its policy under it:
 * `memberships`, `instances`, `versions` and `subjects` by key, and the other
 * sources and `settings` inside `options.options`. A plain policy changes
 * nothing.
 */
function withDefinition<V extends PolicyVocabulary, TSource, TVersions>(
  options: ResolverOptions<V, TSource, TVersions>,
): ResolverOptions<V, TSource, TVersions> {
  const app = appOf(options.policy);
  if (app === undefined) return options;
  const { memberships, instances, ...sources } = instanceOptions(app);
  return {
    ...options,
    ...compact({
      memberships: options.memberships ?? memberships,
      instances: options.instances ?? instances,
      // SAFETY: the app's version cache is a PermDock VersionCache, which every caller's cache type includes.
      versions: options.versions ?? (app.versions as TVersions | undefined),
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
 * One sources object per version cache, so every instance of one subject at one
 * version shares an `instances` entry. Used by `permdockFor` and by the
 * `permdock/supabase` definition.
 */
export function createResolver<V extends PolicyVocabulary, TSource, TVersions>(
  given: ResolverOptions<V, TSource, TVersions>,
): Resolver<V, TSource, TVersions> {
  const { versions: anyVersions, ...definition } = withDefinition(given);
  const { subjectOf, versionCacheOf, ...rest } = definition;
  const cache = versionCacheOf(anyVersions);
  const options = {
    ...rest,
    ...(cache === undefined ? {} : { versions: cache }),
  };
  const versionSourcesFor = versionSources(options);
  const sourcesFor = (versions?: TVersions): InstanceOptions =>
    versionSourcesFor(versionCacheOf(versions));
  const resolve = async (
    source: TSource,
    query: ResolverQuery,
    runtimeVersions?: TVersions,
  ): Promise<PermDock<V>> => {
    const result = isAccessResult(source) ? source : undefined;
    const signedOut = result?.sessionActive === false;
    const user = subjectOf(source, result, signedOut);
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
        const record =
          result?.subject === undefined
            ? undefined
            : readSubjectRecord(result.subject);
        if (
          record?.active === true &&
          (result?.subjectTenant ?? tenant ?? null) === (tenant ?? null) &&
          record.id === id &&
          record.authzVersion === known
        ) {
          await options.subjects.seed(record);
        }
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
 * One `{ allowed, outcome, reason? }` per named check for `input`, from one
 * resolved instance: frozen plain JSON an island returns from `'use cache:
 * private'`. A check that throws denies its entry; an instance that cannot be
 * built denies them all.
 */
export async function getPermissions<TSource, K extends string>(
  resolve: (
    source: TSource,
    query?: ResolverQuery | string | null,
  ) => Promise<PermDock>,
  input: TSource,
  checks: Readonly<Record<K, PermissionCheck>>,
  query?: ResolverQuery | string | null,
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
