import type { InstanceCache } from "./instance-cache.ts";
import type { InstanceOptions } from "./instance-options.ts";
import type { MembershipSource } from "./interfaces.ts";
import type { PermDockOptions } from "./permdock.ts";
import type { VersionCache } from "./version-cache.ts";

import { claimsFirst } from "./memberships.ts";

export type VersionSourcesInput = {
  readonly options?: Omit<PermDockOptions, "tenant" | "intent" | "version">;
  readonly instances?: InstanceCache;
  readonly memberships?: MembershipSource | readonly MembershipSource[];
  readonly version?: MembershipSource["version"];
  readonly versions?: VersionCache;
};

/**
 * The instance options for one version cache: `memberships` wrapped in
 * `claimsFirst(source, { onStale: 'reread', versions })`. One object per cache,
 * so every instance of a subject at one version shares an `instances` entry.
 */
export function versionSources(
  input: VersionSourcesInput,
): (versions?: VersionCache) => InstanceOptions {
  const byCache = new WeakMap<VersionCache, InstanceOptions>();
  let uncached: InstanceOptions | undefined;
  const build = (versions: VersionCache | undefined): InstanceOptions => ({
    ...input.options,
    ...(input.instances === undefined ? {} : { instances: input.instances }),
    ...(input.memberships === undefined
      ? {}
      : {
          memberships: claimsFirst(input.memberships, {
            onStale: "reread",
            ...(input.version === undefined ? {} : { version: input.version }),
            ...(versions === undefined ? {} : { versions }),
          }),
        }),
  });
  return (given) => {
    const versions = given ?? input.versions;
    if (versions === undefined) {
      uncached ??= build(undefined);
      return uncached;
    }
    const known = byCache.get(versions);
    if (known !== undefined) return known;
    const created = build(versions);
    byCache.set(versions, created);
    return created;
  };
}
