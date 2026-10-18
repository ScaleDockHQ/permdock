import type { InstanceOptions } from "./instance-options.ts";
import type { PermDock, PermDockOptions } from "./permdock.ts";
import type { Policy, PolicyVocabulary } from "./policy-types.ts";
import type { Principal } from "./subject.ts";

import { compact } from "./compact.ts";
import { instanceOptions } from "./instance-options.ts";
import { getPermDock } from "./permdock.ts";

/**
 * `resolve()`, or `null` when it throws: a subject or delegation that cannot
 * be resolved is absent. `rethrow` sees the error first, so a framework's
 * control-flow throws (Next.js `redirect`, `notFound`) pass through.
 */
export async function resolveOrNull<T>(
  resolve: () => T | Promise<T>,
  rethrow?: (error: unknown) => void,
): Promise<T | null> {
  try {
    return await resolve();
  } catch (error) {
    rethrow?.(error);
    return null;
  }
}

export type BuildInstanceInput<
  TUser,
  TPrincipal extends Principal,
  V extends PolicyVocabulary,
> = {
  readonly policy: Policy<TUser, TPrincipal, V>;
  readonly user: TUser | null;
  /** The adapter's options; only their `InstanceOptions` keys are read. */
  readonly sources: InstanceOptions;
  /** Set after `sources`, so an adapter's own `sink` or `tenant` wins. */
  readonly scope?: {
    readonly [K in keyof PermDockOptions]?: PermDockOptions[K] | undefined;
  };
  /** Applied last; with `buildReportingInstance`, after the error channel. */
  readonly wrap?: ((permdock: PermDock<V>) => PermDock<V>) | undefined;
};

export type BuiltInstance<V extends PolicyVocabulary> = {
  readonly permdock: PermDock<V>;
  /** The core options the instance was created with. */
  readonly options: PermDockOptions;
};

/** The one path every server adapter creates a request's instance through. */
export async function buildInstance<
  TUser,
  TPrincipal extends Principal,
  V extends PolicyVocabulary,
>(input: BuildInstanceInput<TUser, TPrincipal, V>): Promise<BuiltInstance<V>> {
  const options: PermDockOptions = compact({
    ...instanceOptions(input.sources),
    ...input.scope,
  });
  const created = await getPermDock(input.policy, input.user, options);
  return {
    permdock: input.wrap === undefined ? created : input.wrap(created),
    options,
  };
}
