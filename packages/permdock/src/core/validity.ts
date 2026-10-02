import type { GrantValidity } from './policy.ts';

/**
 * An instant as Unix seconds: a finite number is taken as seconds already, a
 * string must parse as RFC 3339. Anything else is `undefined`, and the caller
 * decides whether that is "absent" or an error.
 */
function instantOf(input: unknown): number | undefined {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? Math.floor(input) : undefined;
  }
  if (typeof input !== 'string' || input.trim() === '') {
    return undefined;
  }
  const millis = Date.parse(input);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : undefined;
}

/**
 * The normalised validity of a grant, or `undefined` when neither bound is
 * set. Fail-closed at definition time: a bound that does not parse, or a
 * window that ends before it starts, throws so a typo never widens a grant.
 */
export function normalizeValidity(
  options: {
    readonly validFrom?: string | number;
    readonly validUntil?: string | number;
  },
  permissionKey: string,
): GrantValidity | undefined {
  const from =
    options.validFrom === undefined ? undefined : instantOf(options.validFrom);
  const until =
    options.validUntil === undefined
      ? undefined
      : instantOf(options.validUntil);
  if (options.validFrom !== undefined && from === undefined) {
    throw new Error(
      `PermDock: validFrom on '${permissionKey}' must be an RFC 3339 string or Unix seconds`,
    );
  }
  if (options.validUntil !== undefined && until === undefined) {
    throw new Error(
      `PermDock: validUntil on '${permissionKey}' must be an RFC 3339 string or Unix seconds`,
    );
  }
  if (from !== undefined && until !== undefined && until <= from) {
    throw new Error(
      `PermDock: validUntil on '${permissionKey}' must be after validFrom`,
    );
  }
  if (from === undefined && until === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(from === undefined ? {} : { from }),
    ...(until === undefined ? {} : { until }),
  });
}

/** Whether a grant with this validity applies at `now` (Unix seconds); no validity always applies. */
export function isActive(
  validity: GrantValidity | undefined,
  now: number,
): boolean {
  if (validity === undefined) {
    return true;
  }
  if (validity.from !== undefined && now < validity.from) {
    return false;
  }
  return validity.until === undefined || now < validity.until;
}
