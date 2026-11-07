import type { InstanceCache } from "../core/instance-cache.ts";
import type { SubjectCache } from "../core/subject-cache.ts";
import type { VersionCache } from "../core/version-cache.ts";

import { instanceCache } from "../core/instance-cache.ts";
import { memorySubjectCache } from "../core/subject-cache.ts";
import { memoryVersionCache } from "../core/version-cache.ts";

export type OwnedCaches = {
  readonly versions: VersionCache;
  readonly instances: InstanceCache;
  readonly subjects: SubjectCache;
};

/**
 * The version, instance and subject caches one definition owns. They are
 * created per call, so two definitions never share a cache.
 */
export function ownedCaches(options: {
  readonly maxStaleMs?: number;
  readonly versions?: VersionCache;
  readonly instances?: InstanceCache;
  readonly subjects?: SubjectCache;
}): OwnedCaches {
  const stale =
    options.maxStaleMs === undefined ? {} : { maxStaleMs: options.maxStaleMs };
  return {
    versions: options.versions ?? memoryVersionCache(stale),
    instances: options.instances ?? instanceCache(),
    subjects: options.subjects ?? memorySubjectCache(stale),
  };
}

/**
 * A frozen copy of `app` (same prototype, same own properties, the app symbol
 * included) with `members` added and the properties named in `replaced` dropped
 * first.
 */
export function withMembers<T extends object, M extends object>(
  app: T,
  members: M,
  replaced: readonly string[] = [],
): T & M {
  // SAFETY: getPrototypeOf returns the policy prototype or null, which Object.create accepts.
  const prototype = Object.getPrototypeOf(app) as object | null;
  const descriptors = Object.getOwnPropertyDescriptors(app);
  for (const name of replaced) {
    Reflect.deleteProperty(descriptors, name);
  }
  // SAFETY: the descriptors are the app's own properties, so the copy is that definition plus the members added below.
  const definition = Object.create(prototype, descriptors) as T & M;
  for (const key of Reflect.ownKeys(members)) {
    Object.defineProperty(definition, key, {
      value: Reflect.get(members, key),
    });
  }
  return Object.freeze(definition);
}
