import type { PermDock } from "./permdock.ts";
import type { PolicyVocabulary } from "./policy-types.ts";

import { canAllWith, decideAllWith } from "./checks.ts";
import { attachInternals, internalsOf } from "./internals.ts";

/** A wrapper an adapter applies to each instance it builds, as `withOtel` does. */
export type PermDockWrap = <V extends PolicyVocabulary>(
  permdock: PermDock<V>,
) => PermDock<V>;

/**
 * The members `wrapPermDock` replaces; it re-wraps the derived instances
 * itself.
 */
export type PermDockOverrides<V extends PolicyVocabulary = PolicyVocabulary> =
  Partial<Omit<PermDock<V>, "tenant" | "team" | "derive">>;

/**
 * A frozen copy of `permdock` with the members `overrides` returns replaced.
 * `overrides` runs again for every instance `tenant()`, `team()` and `derive()`
 * return, so a wrapper never falls off a derived instance.
 */
export function wrapPermDock<V extends PolicyVocabulary = PolicyVocabulary>(
  permdock: PermDock<V>,
  overrides: (permdock: PermDock<V>) => PermDockOverrides<V>,
): PermDock<V> {
  const wrap = (next: PermDock<V>): PermDock<V> =>
    wrapPermDock(next, overrides);
  const replaced = { ...permdock, ...overrides(permdock) };
  // `canAll` and `decideAll` follow the replaced `can` and `decide`, so a
  // wrapper that only overrides those still sees every batched check.
  const wrapped: PermDock<V> = {
    ...replaced,
    canAll: (checks, options) => canAllWith(replaced.can, checks, options),
    decideAll: (checks, options) =>
      decideAllWith(replaced.decide, checks, options),
    tenant: (id: string): PermDock<V> => wrap(permdock.tenant(id)),
    team: (id: string): PermDock<V> => wrap(permdock.team(id)),
    derive: async (
      options: Parameters<PermDock<V>["derive"]>[0],
    ): Promise<PermDock<V>> => wrap(await permdock.derive(options)),
  };
  // The spread skips the non-enumerable internals: carry them over so
  // feature functions (whoCan, decideCredential) work on a wrapped instance.
  const internals = internalsOf(permdock);
  if (internals !== undefined) {
    attachInternals(wrapped, internals);
  }
  return Object.freeze(wrapped);
}

/** `otel`, then `wrap`. */
export function composeWraps(
  otel: PermDockWrap | undefined,
  wrap: PermDockWrap | undefined,
): PermDockWrap | undefined {
  if (otel === undefined || wrap === undefined) {
    return otel ?? wrap;
  }
  return (permdock) => wrap(otel(permdock));
}
