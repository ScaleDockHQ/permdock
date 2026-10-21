import type { GrantLimit } from "./policy-types.ts";

import { durationOf } from "./time.ts";

/** Throws at definition time for a `limit` no store could count. */
export function assertLimit(
  limit: GrantLimit | undefined,
  permissionKey: string,
): void {
  if (limit === undefined) {
    return;
  }
  if (!Number.isSafeInteger(limit.count) || limit.count <= 0) {
    throw new Error(
      `PermDock: limit count on '${permissionKey}' must be a positive integer`,
    );
  }
  if (durationOf(limit.per) === undefined) {
    throw new Error(
      `PermDock: limit per on '${permissionKey}' must be a whole number of seconds above 0 (3600 for an hour), got ${JSON.stringify(limit.per)}`,
    );
  }
  if (
    limit.mode !== undefined &&
    limit.mode !== "hard" &&
    limit.mode !== "soft"
  ) {
    throw new Error(
      `PermDock: limit mode on '${permissionKey}' must be 'hard' or 'soft'`,
    );
  }
  if (
    limit.alertAt !== undefined &&
    (typeof limit.alertAt !== "number" ||
      !(limit.alertAt > 0 && limit.alertAt <= 1))
  ) {
    throw new Error(
      `PermDock: limit alertAt on '${permissionKey}' must be a fraction above 0 and at most 1`,
    );
  }
}

/**
 * The declared fields of a validated `limit`, so extra keys never reach the
 * grant.
 */
export function normalizeLimit(
  limit: GrantLimit | undefined,
): GrantLimit | undefined {
  if (limit === undefined) {
    return undefined;
  }
  return {
    count: limit.count,
    per: limit.per,
    ...(limit.mode === undefined ? {} : { mode: limit.mode }),
    ...(limit.alertAt === undefined ? {} : { alertAt: limit.alertAt }),
  };
}
