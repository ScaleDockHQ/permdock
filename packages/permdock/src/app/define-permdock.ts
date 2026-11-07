import type { AppDefinition, AppOptions, ClientSources } from "../core/app.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { PermDock, PermDockOptions } from "../core/permdock.ts";
import type { Grant, Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Principal, Subject } from "../core/subject.ts";
import type { VersionCache } from "../core/version-cache.ts";
import type { JwtSubjectOptions } from "../jwt/types.ts";

import { memoryApprovalStore } from "../approvals/store.ts";
import { APP } from "../core/app.ts";
import { compact, isRecord } from "../core/compact.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { limits, memoryLimitStore } from "../core/limits.ts";
import { getPermDock } from "../core/permdock.ts";
import { versionSources } from "../core/version-sources.ts";
import { mapClaimsToSubject } from "../jwt/map-claims.ts";
import { subjectFromApiKey } from "../server/kit.ts";

function grantsOf(policy: Policy): readonly Grant[] {
  return [...policy.index.grantsByKey.values()].flat();
}

function assertProduction(policy: Policy, options: AppDefinition): void {
  const grants = grantsOf(policy);
  if (
    options.store === undefined &&
    grants.some((grant) => grant.approval !== undefined)
  ) {
    throw new Error(
      "PermDock: profile 'prod' needs a store: a grant requires approval and approvals cannot complete without an ApprovalStore",
    );
  }
  if (
    options.limits === undefined &&
    grants.some((grant) => grant.limit !== undefined)
  ) {
    throw new Error(
      "PermDock: profile 'prod' needs limits: a grant has a limit and every call would deny with limit-unavailable; pass limits: limits(store)",
    );
  }
}

/**
 * The in-process services `dev` fills in: one memory approval store that every
 * adapter of the app shares, and memory limits when a grant has a `limit`. They
 * live here, not in the adapters, so an adapter ships no store and an app
 * without `definePermDock` ships neither.
 */
function devDefaults(
  policy: Policy,
  options: Omit<AppOptions, "sources"> & Pick<AppDefinition, "sources">,
): AppDefinition {
  return {
    ...options,
    profile: "dev",
    ...(options.store === undefined ? { store: memoryApprovalStore() } : {}),
    ...(options.limits === undefined &&
    grantsOf(policy).some((grant) => grant.limit !== undefined)
      ? { limits: limits(memoryLimitStore()) }
      : {}),
  };
}

/**
 * What `getPermDock` takes beside the user: the tenant and intent of one
 * request.
 */
export type PermDockQuery = Pick<PermDockOptions, "tenant" | "intent">;

/** The members `definePermDock` adds to the policy it binds. */
export type PermDockApp<
  V extends PolicyVocabulary = PolicyVocabulary,
  TClient extends object = object,
  TUser = unknown,
  TPrincipal extends Principal = Principal,
> = {
  /** The instance for `user`, built with the app's sources and caches. */
  readonly getPermDock: (
    user: unknown,
    query?: PermDockQuery,
  ) => Promise<PermDock<V>>;
  /**
   * The instance for claims a provider already verified, mapped through the
   * `claims` option. Claims with no usable id are anonymous.
   */
  readonly fromClaims: (
    claims: Readonly<Record<string, unknown>>,
    query?: PermDockQuery,
  ) => Promise<PermDock<V>>;
  /**
   * The instance for an opaque API key, verified through the `credentials`
   * option. Any failure is the anonymous subject. Throws a `TypeError` when the
   * app has no `credentials`.
   */
  readonly fromApiKey: (
    key: string | null | undefined,
    query?: PermDockQuery,
  ) => Promise<PermDock<V>>;
  /**
   * The instance options for one version cache (default the `versions` option),
   * the same object on every call: pass it to an adapter that takes instance
   * options so they share the `claimsFirst` memberships and `instances`
   * entries.
   */
  readonly sources: (versions?: VersionCache) => InstanceOptions;
  /** Drops the principal's instances, authorization version and subject record. */
  readonly evict: (principal: string) => Promise<void>;
  /**
   * The definition bound to `client`: the same policy, caches and services,
   * with `memberships`, `customRoles` and `subjects` from
   * `options.sources(client)`, which runs once per client (cached in a
   * `WeakMap`). Throws a `TypeError` when the app has no `sources` option.
   */
  readonly forClient: (
    client: TClient,
  ) => PermDockDefinition<TUser, TPrincipal, V, TClient>;
};

/**
 * A policy that carries the app definition and the `PermDockApp` members. It is
 * a `Policy`: pass it wherever a policy goes.
 */
export type PermDockDefinition<
  TUser = unknown,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
  TClient extends object = object,
> = Policy<TUser, TPrincipal, V> & PermDockApp<V, TClient, TUser, TPrincipal>;

/**
 * Binds the app's sources, caches, features and services to `policy` and adds
 * `getPermDock`, `fromClaims`, `fromApiKey`, `sources` and `evict`. The result
 * is a policy: pass it wherever a policy goes (`createPermDock`, every adapter,
 * the CLI) and each picks up the app definition, with its own options taking
 * precedence. The profile defaults to `prod`. Server-only: nothing here belongs
 * in a client bundle.
 */
export function definePermDock<
  TUser,
  TPrincipal extends Principal,
  V extends PolicyVocabulary,
  TClient extends object = object,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: AppOptions<TClient> = {},
): PermDockDefinition<TUser, TPrincipal, V, TClient> {
  const profile = options.profile ?? "prod";
  // SAFETY: the sources factory is only called with the TClient that forClient takes.
  const given = options as Omit<AppOptions, "sources"> &
    Pick<AppDefinition, "sources">;
  const definition: AppDefinition =
    profile === "dev" ? devDefaults(policy, given) : { ...given, profile };
  if (profile === "prod") {
    assertProduction(policy, definition);
  }
  const perClient = new WeakMap<object, ClientSources>();
  const boundByClient = new WeakMap<
    object,
    PermDockDefinition<TUser, TPrincipal, V, TClient>
  >();
  const sourcesOfClient = (client: TClient): ClientSources => {
    if (definition.sources === undefined) {
      throw new TypeError(
        "PermDock: forClient needs the sources option of definePermDock",
      );
    }
    if (typeof client !== "object" && typeof client !== "function") {
      throw new TypeError("PermDock: forClient takes an object client");
    }
    const cached = perClient.get(client);
    if (cached !== undefined) {
      return cached;
    }
    // SAFETY: sources was declared for TClient and client is one.
    const made = (definition.sources as (client: TClient) => ClientSources)(
      client,
    );
    perClient.set(client, made);
    return made;
  };
  const bind = (
    bound: AppDefinition,
  ): PermDockDefinition<TUser, TPrincipal, V, TClient> => {
    // SAFETY: a policy is a plain object (or null-prototype); the copy keeps its prototype and every own property, symbol-keyed ones included.
    const prototype = Object.getPrototypeOf(policy) as object | null;
    // SAFETY: the copy has the policy's own property descriptors, so it is the same Policy shape; the members are added below.
    const app = Object.create(
      prototype,
      Object.getOwnPropertyDescriptors(policy),
    ) as PermDockDefinition<TUser, TPrincipal, V, TClient>;
    Object.defineProperty(app, APP, { value: Object.freeze(bound) });

    const {
      memberships: _m,
      instances: _i,
      ...sourcesOf
    } = instanceOptions(bound);
    const sources = versionSources({
      ...(bound.memberships === undefined
        ? {}
        : { memberships: bound.memberships }),
      ...(bound.instances === undefined ? {} : { instances: bound.instances }),
      ...(bound.versions === undefined ? {} : { versions: bound.versions }),
      options: {
        ...sourcesOf,
        ...(bound.settings === undefined ? {} : { settings: bound.settings }),
      },
    });
    const build = (
      user: unknown,
      query: PermDockQuery | undefined,
    ): Promise<PermDock<V>> =>
      // SAFETY: the app is a policy of this TUser; a Subject or a user the mapper reads is what getPermDock takes.
      getPermDock(app, user as TUser, { ...sources(), ...query });
    const mapClaims = (claims: Readonly<Record<string, unknown>>): Subject =>
      mapClaimsToSubject(
        claims,
        // SAFETY: mapClaimsToSubject reads the claims map and the options a verifier does not set; the verifier options of JwtSubjectOptions are never read.
        compact({ claims: bound.claims }) as JwtSubjectOptions,
      ).subject;
    const members: PermDockApp<V, TClient, TUser, TPrincipal> = {
      getPermDock: build,
      fromClaims: (claims, query) =>
        build(isRecord(claims) ? mapClaims(claims) : null, query),
      async fromApiKey(key, query) {
        const credentials = bound.credentials;
        if (credentials === undefined) {
          throw new TypeError(
            "PermDock: fromApiKey needs the credentials option of definePermDock",
          );
        }
        const tenant = query?.tenant ?? credentials.tenant;
        const subject = await subjectFromApiKey(key, {
          ...credentials,
          permissions: policy.permissions,
          ...(tenant === undefined ? {} : { tenant }),
        });
        return build(subject, query);
      },
      sources,
      async evict(principal) {
        bound.versions?.evict(principal);
        bound.instances?.evict(principal);
        await bound.subjects?.evict(principal);
      },
      forClient(client) {
        const { memberships, customRoles, subjects } = sourcesOfClient(client);
        const known = boundByClient.get(client);
        if (known !== undefined) {
          return known;
        }
        const made = bind({
          ...definition,
          ...(memberships === undefined ? {} : { memberships }),
          ...(customRoles === undefined ? {} : { customRoles }),
          ...(subjects === undefined ? {} : { subjects }),
        });
        boundByClient.set(client, made);
        return made;
      },
    };
    for (const [name, value] of Object.entries(members)) {
      Object.defineProperty(app, name, { value });
    }
    return Object.freeze(app);
  };
  return bind(definition);
}
