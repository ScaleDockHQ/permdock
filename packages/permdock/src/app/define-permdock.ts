import type { AppDefinition, AppOptions } from "../core/app.ts";
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

function assertProduction(policy: Policy, options: AppOptions): void {
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
function devDefaults(policy: Policy, options: AppOptions): AppDefinition {
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
export type PermDockApp<V extends PolicyVocabulary = PolicyVocabulary> = {
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
};

/**
 * A policy that carries the app definition and the `PermDockApp` members. It is
 * a `Policy`: pass it wherever a policy goes.
 */
export type PermDockDefinition<
  TUser = unknown,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
> = Policy<TUser, TPrincipal, V> & PermDockApp<V>;

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
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: AppOptions = {},
): PermDockDefinition<TUser, TPrincipal, V> {
  const profile = options.profile ?? "prod";
  const definition: AppDefinition =
    profile === "dev" ? devDefaults(policy, options) : { ...options, profile };
  if (profile === "prod") {
    assertProduction(policy, definition);
  }
  // SAFETY: a policy is a plain object (or null-prototype); the copy keeps its prototype and every own property, symbol-keyed ones included.
  const prototype = Object.getPrototypeOf(policy) as object | null;
  // SAFETY: the copy has the policy's own property descriptors, so it is the same Policy shape; the members are added below.
  const app = Object.create(
    prototype,
    Object.getOwnPropertyDescriptors(policy),
  ) as PermDockDefinition<TUser, TPrincipal, V>;
  Object.defineProperty(app, APP, { value: Object.freeze(definition) });

  const {
    memberships: _m,
    instances: _i,
    ...sourcesOf
  } = instanceOptions(definition);
  const sources = versionSources({
    ...(definition.memberships === undefined
      ? {}
      : { memberships: definition.memberships }),
    ...(definition.instances === undefined
      ? {}
      : { instances: definition.instances }),
    ...(definition.versions === undefined
      ? {}
      : { versions: definition.versions }),
    options: {
      ...sourcesOf,
      ...(definition.settings === undefined
        ? {}
        : { settings: definition.settings }),
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
      compact({ claims: definition.claims }) as JwtSubjectOptions,
    ).subject;
  const members: PermDockApp<V> = {
    getPermDock: build,
    fromClaims: (claims, query) =>
      build(isRecord(claims) ? mapClaims(claims) : null, query),
    async fromApiKey(key, query) {
      const credentials = definition.credentials;
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
      definition.versions?.evict(principal);
      definition.instances?.evict(principal);
      await definition.subjects?.evict(principal);
    },
  };
  for (const [name, value] of Object.entries(members)) {
    Object.defineProperty(app, name, { value });
  }
  return Object.freeze(app);
}
