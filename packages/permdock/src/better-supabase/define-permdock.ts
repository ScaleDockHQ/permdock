import type {
  PermDockQuery,
  PermDockDefinition,
} from "../app/define-permdock.ts";
import type { AppOptions, ClientSources } from "../core/app.ts";
import type { PermissionCheck, PermissionState } from "../core/checks.ts";
import type { CustomRoleSource } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Principal, Subject } from "../core/subject.ts";
import type { VersionCache } from "../core/version-cache.ts";
import type { SupabaseClaimsClient } from "../supabase/client-subject.ts";
import type { PostgrestSourcesOptions } from "../supabase/postgrest.ts";
import type { SupabaseSubjectOptions } from "../supabase/types.ts";
import type { AuthorizerOptions } from "./authorizer.ts";
import type {
  PermDockFor,
  PermDockForInput,
  PermDockForQuery,
} from "./permdock-for.ts";
import type { BetterSupabaseSubjectOptions } from "./subject.ts";

import { definePermDock as defineApp } from "../app/define-permdock.ts";
import { isRecord } from "../core/compact.ts";
import { getPermDock } from "../core/permdock.ts";
import { ownedCaches, withMembers } from "../supabase/app-members.ts";
import { subjectFromSupabaseClient } from "../supabase/client-subject.ts";
import { SUPABASE_OPTIONS } from "../supabase/definition-options.ts";
import { postgrestSources } from "../supabase/postgrest.ts";
import { authorizer } from "./authorizer.ts";
import { getPermissions, permdockFor } from "./permdock-for.ts";

type AuthorizerExtra<V extends PolicyVocabulary> = Omit<
  AuthorizerOptions<V>,
  "policy" | "permdockFor"
>;

/** The query `fromClaims` takes: a request, plus a known authorization version. */
export type BetterSupabaseQuery = PermDockQuery & { readonly version?: number };

export type BetterSupabaseServerInput = {
  readonly subject: Subject;
  readonly tenant?: string;
  readonly operations?: Readonly<Record<string, unknown>>;
};

/** What `next()` returns for better-supabase's `createNext`. */
export type BetterSupabaseNext<V extends PolicyVocabulary> = {
  readonly authorization: ReturnType<typeof authorizer<V>>;
  readonly authorizer: ReturnType<typeof authorizer<V>>;
  readonly versions: VersionCache;
};

export type BetterSupabaseDefineOptions<TClient extends object = object> =
  AppOptions<TClient> & {
    /** The shared admin client. Called once, the first time `client()` runs. */
    readonly client?: () => TClient | Promise<TClient>;
    readonly apiKeys?: BetterSupabaseSubjectOptions["apiKeys"];
    /**
     * How verified claims map to a subject for `fromClient` and for
     * `permdock/supabase/middleware`'s `createPermDock(definition)`.
     */
    readonly subject?: SupabaseSubjectOptions;
    /** The `supabase.hook.api` setting the hook file was generated with. */
    readonly api?: PostgrestSourcesOptions["api"];
    readonly clients?: Readonly<Record<string, string>>;
    readonly maxStaleMs?: number;
    readonly onSourceCall?: (name: string) => void;
  };

type AppMembers<
  V extends PolicyVocabulary,
  TClient extends object,
  TUser,
  TPrincipal extends Principal,
> = PermDockDefinition<TUser, TPrincipal, V, TClient>;

/** The better-supabase definition: the app members, plus the adapter members. */
export type BetterSupabasePermDock<
  TUser = unknown,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
  TClient extends object = object,
> = AppMembers<V, TClient, TUser, TPrincipal> & {
  readonly client: () => Promise<TClient>;
  readonly fromClaims: (
    claims: Readonly<Record<string, unknown>>,
    query?: BetterSupabaseQuery,
  ) => Promise<PermDock<V>>;
  /** The instance for the session of a supabase-js or `@supabase/ssr` client. */
  readonly fromClient: (
    client: SupabaseClaimsClient,
    query?: PermDockQuery,
  ) => Promise<PermDock<V>>;
  readonly server: (input: BetterSupabaseServerInput) => Promise<PermDock<V>>;
  readonly authorizer: (
    extra?: AuthorizerExtra<V>,
  ) => ReturnType<typeof authorizer<V>>;
  readonly next: (extra?: AuthorizerExtra<V>) => BetterSupabaseNext<V>;
  readonly getPermissions: <K extends string>(
    input: PermDockForInput,
    checks: Readonly<Record<K, PermissionCheck>>,
    query?: PermDockForQuery | string | null,
  ) => Promise<Readonly<Record<K, PermissionState>>>;
};

function withVersion<
  TUser,
  TPrincipal extends Principal,
  V extends PolicyVocabulary,
  TClient extends object,
>(
  app: PermDockDefinition<TUser, TPrincipal, V, TClient>,
  permdock: PermDock<V>,
  query: BetterSupabaseQuery | undefined,
): Promise<PermDock<V>> {
  const version = query?.version;
  if (version === undefined) {
    return Promise.resolve(permdock);
  }
  const { version: _version, ...rest } = query ?? {};
  return getPermDock(app, permdock.subject, {
    ...app.sources(),
    ...rest,
    version: { known: version },
  });
}

/**
 * Binds one better-supabase app to `policy`. Caches are created here, so two
 * definitions never share a version, instance or subject cache. `client()`
 * loads the shared admin client the first time it is called. `.authorizer` and
 * `.next` live here, not on `permdock/app`.
 */
export function definePermDock<
  TUser,
  TPrincipal extends Principal,
  V extends PolicyVocabulary,
  TClient extends object = object,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: BetterSupabaseDefineOptions<TClient> = {},
): BetterSupabasePermDock<TUser, TPrincipal, V, TClient> {
  const caches = ownedCaches(options);
  const {
    client: load,
    apiKeys,
    subject: subjectOptions,
    api,
    sources: given,
    clients: _clients,
    maxStaleMs: _maxStaleMs,
    onSourceCall: _onSourceCall,
    ...appOptions
  } = options;
  const app = defineApp(policy, {
    ...appOptions,
    versions: caches.versions,
    instances: caches.instances,
    subjects: caches.subjects,
    sources:
      given ??
      ((sourceClient: TClient): ClientSources => {
        // SAFETY: the sources factory runs only for a client that reads subject_for, which postgrestSources checks at call time.
        const pg = postgrestSources(sourceClient as never, {
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
  const dock: PermDockFor<V> = permdockFor({
    policy: app,
    versions: caches.versions,
    instances: caches.instances,
    subjects: caches.subjects,
    ...(apiKeys === undefined ? {} : { subject: { apiKeys } }),
  });
  const made = (extra?: AuthorizerExtra<V>): ReturnType<typeof authorizer<V>> =>
    authorizer({ policy: app, permdockFor: dock, ...extra });
  const members = {
    client: (): Promise<TClient> => {
      if (load === undefined) {
        throw new TypeError(
          "PermDock: client() needs the client option of definePermDock",
        );
      }
      pending ??= Promise.resolve(load());
      return pending;
    },
    fromClaims: (
      claims: Readonly<Record<string, unknown>>,
      query?: BetterSupabaseQuery,
    ): Promise<PermDock<V>> => {
      const { version: _version, ...rest } = query ?? {};
      return app
        .fromClaims(claims, rest)
        .then((permdock) => withVersion(app, permdock, query));
    },
    fromClient: async (
      client: SupabaseClaimsClient,
      query?: PermDockQuery,
    ): Promise<PermDock<V>> =>
      app.getPermDock(
        await subjectFromSupabaseClient(client, subjectOptions),
        query,
      ),
    server: (input: BetterSupabaseServerInput): Promise<PermDock<V>> => {
      if (input.operations !== undefined && !isRecord(input.operations)) {
        throw new TypeError("PermDock: server operations must be an object");
      }
      const query = input.tenant === undefined ? {} : { tenant: input.tenant };
      return app.getPermDock(input.subject, query);
    },
    authorizer: made,
    next: (extra?: AuthorizerExtra<V>): BetterSupabaseNext<V> => {
      const gate = made(extra);
      return {
        authorization: gate,
        authorizer: gate,
        versions: caches.versions,
      };
    },
    getPermissions: <K extends string>(
      input: PermDockForInput,
      checks: Readonly<Record<K, PermissionCheck>>,
      query?: PermDockForQuery | string | null,
    ): Promise<Readonly<Record<K, PermissionState>>> =>
      getPermissions(dock, input, checks, query),
  };
  return withMembers(app, { ...members, [SUPABASE_OPTIONS]: subjectOptions }, [
    "fromClaims",
  ]);
}
