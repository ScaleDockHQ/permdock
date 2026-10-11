import type { PermDock } from "./permdock.ts";
import type { PolicyVocabulary } from "./policy-types.ts";

/** A wrapper an adapter applies to each instance it builds, as `withOtel` does. */
export type PermDockWrap = <V extends PolicyVocabulary>(
  permdock: PermDock<V>,
) => PermDock<V>;

/** The members `wrapPermDock` replaces; it re-wraps the derived instances itself. */
export type PermDockOverrides<V extends PolicyVocabulary = PolicyVocabulary> =
  Partial<Omit<PermDock<V>, "tenant" | "team" | "derive">>;

/**
 * A frozen copy of `permdock` with the members `overrides` returns replaced.
 * `overrides` runs again for every instance `tenant()`, `team()` and
 * `derive()` return, so a wrapper never falls off a derived instance.
 */
export function wrapPermDock<V extends PolicyVocabulary = PolicyVocabulary>(
  permdock: PermDock<V>,
  overrides: (permdock: PermDock<V>) => PermDockOverrides<V>,
): PermDock<V> {
  const wrap = (next: PermDock<V>): PermDock<V> =>
    wrapPermDock(next, overrides);
  return Object.freeze({
    ...permdock,
    ...overrides(permdock),
    tenant: (id: string): PermDock<V> => wrap(permdock.tenant(id)),
    team: (id: string): PermDock<V> => wrap(permdock.team(id)),
    derive: (
      options: Parameters<PermDock<V>["derive"]>[0],
    ): PermDock<V> | Promise<PermDock<V>> => {
      const derived = permdock.derive(options);
      return derived instanceof Promise ? derived.then(wrap) : wrap(derived);
    },
  });
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
