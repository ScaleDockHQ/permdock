import type {
  PermDockDefinition,
  PermDockQuery,
} from "../app/define-permdock.ts";
import type { AppOptions, ClientSources } from "../core/app.ts";
import type { PermissionCheck, PermissionState } from "../core/checks.ts";
import type { CustomRoleSource } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Principal, Subject } from "../core/subject.ts";
import type { VersionCache } from "../core/version-cache.ts";
import type { SupabaseClaimsClient } from "./client-subject.ts";
import type {
  PostgrestSourcesOptions,
  SupabaseRpcCaller,
} from "./postgrest.ts";
import type {
  Resolver,
  ResolverQuery,
  SupabaseAccessResult,
} from "./resolver.ts";
import type { SupabaseSubjectOptions } from "./types.ts";

import { definePermDock as defineApp } from "../app/define-permdock.ts";
import { isRecord } from "../core/compact.ts";
import { isSubject } from "../core/subject.ts";
import { ownedCaches, withMembers } from "./app-members.ts";
import { subjectFromSupabaseClient } from "./client-subject.ts";
import { SUPABASE_OPTIONS } from "./definition-options.ts";
import { postgrestSources } from "./postgrest.ts";
import { createResolver, getPermissions } from "./resolver.ts";
import { subjectFromSupabase } from "./subject.ts";

/** What `fromClaims` and `fromClient` take beside the subject. */
export type SupabaseQuery = PermDockQuery & {
  /**
   * An authorization version the caller read in the same request, such as a
   * bootstrap's. The instance then reads no version.
   */
  readonly version?: number;
};

/** Who an instance is for: a subject, verified claims or an access result. */
export type SupabaseInput =
  | Subject
  | SupabaseAccessResult
  | Readonly<Record<string, unknown>>
  | null
  | undefined;

export type SupabaseDefineOptions<
  TClient extends SupabaseRpcCaller = SupabaseRpcCaller,
> = Omit<AppOptions<TClient>, "claims"> & {
  /** How verified claims map to a subject, for `fromClaims` and `fromClient`. */
  readonly subject?: SupabaseSubjectOptions;
  /**
   * The backend client that reads `subject_for`, `members_of` and
   * `authz_version_for`. Those functions are revoked from client roles, so use
   * a server-side client. Called once, the first time it is needed.
   */
  readonly client?: () => TClient | Promise<TClient>;
  /** The `supabase.hook.api` setting the hook file was generated with. */
  readonly api?: PostgrestSourcesOptions["api"];
  /** The `maxStaleMs` of the caches this definition owns. */
  readonly maxStaleMs?: number;
};

/** The Supabase definition: the app members, plus the Supabase members. */
export type SupabasePermDock<
  TUser = unknown,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
  TClient extends SupabaseRpcCaller = SupabaseRpcCaller,
> = PermDockDefinition<TUser, TPrincipal, V, TClient> & {
  /** The backend client of the `client` option, loaded once. */
  readonly client: () => Promise<TClient>;
  /**
   * The instance for claims a Supabase client already verified. An `authz_ver`
   * in the claims is checked against the database, never trusted as current;
   * only `query.version` is taken as known.
   */
  readonly fromClaims: (
    claims: Readonly<Record<string, unknown>> | null,
    query?: SupabaseQuery,
  ) => Promise<PermDock<V>>;
  /** The instance for the session of a supabase-js or `@supabase/ssr` client. */
  readonly fromClient: (
    client: SupabaseClaimsClient,
    query?: PermDockQuery,
  ) => Promise<PermDock<V>>;
  readonly getPermissions: <K extends string>(
    input: SupabaseInput,
    checks: Readonly<Record<K, PermissionCheck>>,
    query?: ResolverQuery | string | null,
  ) => Promise<Readonly<Record<K, PermissionState>>>;
};

/**
 * Binds one Supabase app to `policy`: the `permdock/app` definition, with
 * `postgrestSources` over `client` as its default `sources`. Caches are created
 * here, so two definitions never share a version, instance or subject cache.
 */
export function definePermDock<
  TUser,
  TPrincipal extends Principal,
  V extends PolicyVocabulary,
  TClient extends SupabaseRpcCaller = SupabaseRpcCaller,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: SupabaseDefineOptions<TClient> = {},
): SupabasePermDock<TUser, TPrincipal, V, TClient> {
  const caches = ownedCaches(options);
  const {
    client: load,
    subject: subjectOptions,
    api,
    maxStaleMs: _maxStaleMs,
    sources: given,
    ...appOptions
  } = options;
  const app = defineApp<TUser, TPrincipal, V, TClient>(policy, {
    ...appOptions,
    versions: caches.versions,
    instances: caches.instances,
    subjects: caches.subjects,
    sources:
      given ??
      ((client): ClientSources => {
        const pg = postgrestSources(client, {
          policy,
          subjects: caches.subjects,
          ...(api === undefined ? {} : { api }),
        });
        return {
          memberships: pg.memberships,
          customRoles: (subject): CustomRoleSource | undefined =>
            subject.principal === null || subject.principal === undefined
              ? undefined
              : pg.customRoles(subject.principal),
          subjects: caches.subjects,
        };
      }),
  });
  let pending: Promise<TClient> | undefined;
  const loaded = (): Promise<TClient> => {
    if (load === undefined) {
      throw new TypeError(
        "PermDock: client() needs the client option of definePermDock",
      );
    }
    pending ??= Promise.resolve(load());
    return pending;
  };
  const resolvers = new WeakMap<
    object,
    Resolver<V, SupabaseInput, VersionCache>
  >();
  const resolverOf = async (): Promise<
    Resolver<V, SupabaseInput, VersionCache>
  > => {
    const bound = load === undefined ? app : app.forClient(await loaded());
    const known = resolvers.get(bound);
    if (known !== undefined) return known;
    const made = createResolver<V, SupabaseInput, VersionCache>({
      policy: bound,
      subjectOf: (source, result, signedOut) => {
        if (isSubject(source)) return source;
        if (result !== undefined) {
          return subjectFromSupabase(
            signedOut ? null : result.session,
            subjectOptions,
          );
        }
        return subjectFromSupabase(
          isRecord(source) ? source : null,
          subjectOptions,
        );
      },
      versionCacheOf: (cache) => cache,
    });
    resolvers.set(bound, made);
    return made;
  };
  const resolve = async (
    source: SupabaseInput,
    query?: ResolverQuery | string | null,
  ): Promise<PermDock<V>> => {
    const resolver = await resolverOf();
    return resolver(
      source,
      typeof query === "string" || query === null
        ? { tenant: query }
        : (query ?? {}),
    );
  };
  const members = {
    client: loaded,
    fromClaims: (
      claims: Readonly<Record<string, unknown>> | null,
      query?: SupabaseQuery,
    ): Promise<PermDock<V>> => {
      const { version, ...rest } = query ?? {};
      return resolve(
        version === undefined
          ? claims
          : { session: claims, tenant: null, authzVersion: version },
        rest,
      );
    },
    fromClient: async (
      client: SupabaseClaimsClient,
      query?: PermDockQuery,
    ): Promise<PermDock<V>> =>
      resolve(await subjectFromSupabaseClient(client, subjectOptions), query),
    getPermissions: <K extends string>(
      input: SupabaseInput,
      checks: Readonly<Record<K, PermissionCheck>>,
      query?: ResolverQuery | string | null,
    ): Promise<Readonly<Record<K, PermissionState>>> =>
      getPermissions(resolve, input, checks, query),
  };
  return withMembers(app, { ...members, [SUPABASE_OPTIONS]: subjectOptions }, [
    "fromClaims",
  ]);
}
