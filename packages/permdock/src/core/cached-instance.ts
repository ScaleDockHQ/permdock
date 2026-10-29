import type { InstanceCache, InstanceCacheKey } from "./instance-cache.ts";
import type { PermDockOptions } from "./permdock.ts";
import type { Principal } from "./subject.ts";

import { compact } from "./compact.ts";
import { versionQuery } from "./freshness.ts";
import { asMembershipSource } from "./memberships.ts";
import { isSubject } from "./subject.ts";

/** The part of a policy the key reads: its identity and its subject mapper. */
type SubjectMapper = { readonly subject: (user: never) => Principal | null };

/** Options that shape an instance by value; the rest by identity. */
const DATA_KEYS: ReadonlySet<string> = new Set([
  "tenant",
  "intent",
  "actor",
  "delegation",
  "session",
  "expiresAt",
  "context",
]);

function principalOf(
  policy: SubjectMapper,
  user: unknown,
): { readonly principal: Principal; readonly issuedAt?: number } | null {
  if (user === null || user === undefined) {
    return null;
  }
  if (isSubject(user)) {
    return user.principal === null
      ? null
      : compact({ principal: user.principal, issuedAt: user.issuedAt });
  }
  try {
    // SAFETY: TUser is erased at the policy boundary; getPermDock types user as TUser.
    const principal = policy.subject(user as never);
    return principal === null ? null : { principal };
  } catch {
    return null;
  }
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The cache key of an instance, with the options to build it with: the version
 * read for the key is passed on as `version.known`, so the build reads none.
 * `undefined` when the subject or its version is unknown.
 */
async function cacheKey(
  policy: SubjectMapper,
  user: unknown,
  options: PermDockOptions,
): Promise<
  | {
      readonly key: InstanceCacheKey;
      readonly owners: readonly unknown[];
      readonly options: PermDockOptions;
    }
  | undefined
> {
  const resolved = principalOf(policy, user);
  if (resolved === null) {
    return undefined;
  }
  const intent = options.intent ?? "write";
  let version = options.version?.known;
  if (!isVersion(version) && options.memberships !== undefined) {
    try {
      version = await asMembershipSource(options.memberships).version?.(
        versionQuery(resolved.principal, resolved.issuedAt),
        { intent },
      );
    } catch {
      return undefined;
    }
  }
  if (!isVersion(version)) {
    return undefined;
  }
  const data: Record<string, unknown> = {};
  const owners: unknown[] = [policy];
  for (const name of Object.keys(options).toSorted()) {
    const value: unknown = Reflect.get(options, name);
    if (DATA_KEYS.has(name)) {
      data[name] = value;
    } else if (name !== "version") {
      owners.push(value);
    }
  }
  return {
    key: compact({
      principal: resolved.principal.id,
      version,
      tenant: options.tenant,
      intent,
      parts: { user, data },
    }),
    owners,
    options: { ...options, version: { known: version } },
  };
}

function cachedSources(
  options: PermDockOptions,
  instances: InstanceCache,
): PermDockOptions {
  const { customRoles, entitlements } = options;
  return {
    ...options,
    ...(customRoles === undefined || typeof customRoles === "function"
      ? {}
      : { customRoles: instances.customRoles(customRoles) }),
    ...(entitlements === undefined
      ? {}
      : { entitlements: instances.entitlements(entitlements) }),
  };
}

/**
 * `create` through `instances`: a subject whose authorization version is known
 * gets the instance built for it at that version, with the cache's custom-role
 * and entitlement memos; any other subject gets a new one.
 */
export async function cachedInstance<T>(
  policy: SubjectMapper,
  user: unknown,
  options: PermDockOptions,
  instances: InstanceCache,
  create: (options: PermDockOptions) => T | Promise<T>,
): Promise<T> {
  const cached = await cacheKey(policy, user, options);
  if (cached === undefined) {
    return create(options);
  }
  return instances.instance(cached.key, cached.owners, () =>
    Promise.resolve(create(cachedSources(cached.options, instances))),
  );
}
