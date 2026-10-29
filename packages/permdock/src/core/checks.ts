import type { Decision } from "./decision.ts";
import type { DecideOptions } from "./permdock.ts";
import type { Permission } from "./permission-types.ts";

import { isReadonlyArray } from "./compact.ts";

/**
 * One check of `canAll` or `decideAll`: a permission alone, or with the row it
 * is checked on.
 */
export type PermissionCheck =
  | Permission
  | readonly [permission: Permission, data?: unknown];

function partsOf(check: PermissionCheck): readonly [Permission, unknown] {
  return isReadonlyArray(check) ? [check[0], check[1]] : [check, undefined];
}

type CanFn = (
  permission: Permission,
  data: unknown,
  options?: DecideOptions,
) => boolean;

type DecideFn = (
  permission: Permission,
  data: unknown,
  options?: DecideOptions,
) => Decision;

/**
 * `true` when every check is granted, stopping at the first that is not; an
 * empty list is `false`.
 */
export function canAllWith(
  can: CanFn,
  checks: readonly PermissionCheck[],
  options?: DecideOptions,
): boolean {
  if (checks.length === 0) {
    return false;
  }
  return checks.every((check) => {
    const [permission, data] = partsOf(check);
    return can(permission, data, options);
  });
}

/** One decision per check, in check order. */
export function decideAllWith(
  decide: DecideFn,
  checks: readonly PermissionCheck[],
  options?: DecideOptions,
): readonly Decision[] {
  return Object.freeze(
    checks.map((check) => {
      const [permission, data] = partsOf(check);
      return decide(permission, data, options);
    }),
  );
}

/** The async `canAll` of an instance whose `can` answers a Promise. */
export async function canAllAsync(
  can: (
    permission: Permission,
    data: unknown,
    options?: DecideOptions,
  ) => Promise<boolean>,
  checks: readonly PermissionCheck[],
  options?: DecideOptions,
): Promise<boolean> {
  if (checks.length === 0) {
    return false;
  }
  const granted = await Promise.all(
    checks.map((check) => {
      const [permission, data] = partsOf(check);
      return can(permission, data, options);
    }),
  );
  return granted.every(Boolean);
}

/** The async `decideAll` of an instance whose `decide` answers a Promise. */
export async function decideAllAsync(
  decide: (
    permission: Permission,
    data: unknown,
    options?: DecideOptions,
  ) => Promise<Decision>,
  checks: readonly PermissionCheck[],
  options?: DecideOptions,
): Promise<readonly Decision[]> {
  return Object.freeze(
    await Promise.all(
      checks.map((check) => {
        const [permission, data] = partsOf(check);
        return decide(permission, data, options);
      }),
    ),
  );
}

/** One entry of `getPermissions`: plain JSON, safe across a cache boundary. */
export type PermissionState = {
  readonly allowed: boolean;
  readonly outcome: Decision["outcome"];
  /** The first denial's reason; absent unless `outcome` is `denied`. */
  readonly reason?: string;
};

/**
 * One frozen `PermissionState` per named check. A check that throws denies that
 * entry with `validation` and leaves the others.
 */
export function permissionStates<K extends string>(
  decide: DecideFn,
  checks: Readonly<Record<K, PermissionCheck>>,
  options?: DecideOptions,
): Readonly<Record<K, PermissionState>> {
  const states: Partial<Record<K, PermissionState>> = {};
  for (const name of Object.keys(checks)) {
    // SAFETY: Object.keys of a Record<K, …> lists its K keys.
    const key = name as K;
    let state: PermissionState;
    try {
      const [permission, data] = partsOf(checks[key]);
      const decision = decide(permission, data, options);
      const reason =
        decision.outcome === "denied" ? decision.denials[0]?.reason : undefined;
      state = Object.freeze({
        allowed: decision.outcome === "granted",
        outcome: decision.outcome,
        ...(reason === undefined ? {} : { reason }),
      });
    } catch {
      state = Object.freeze({
        allowed: false,
        outcome: "denied",
        reason: "validation",
      });
    }
    Object.defineProperty(states, key, { value: state, enumerable: true });
  }
  // SAFETY: the loop above set one state for every key of checks.
  return Object.freeze(states) as Readonly<Record<K, PermissionState>>;
}
