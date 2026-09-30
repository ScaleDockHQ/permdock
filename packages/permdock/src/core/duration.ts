/**
 * Parses a duration string (`'30s'`, `'15m'`, `'4h'`, `'7d'`, `'2w'`) into
 * whole seconds. Fail-closed: a malformed or non-positive duration is
 * `undefined`, and every caller treats that as "no bound", never a default.
 */
const UNITS: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
};

export function parseDuration(input: unknown): number | undefined {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input > 0 ? Math.floor(input) : undefined;
  }
  if (typeof input !== 'string') {
    return undefined;
  }
  const match = /^(\d+)(s|m|h|d|w)$/u.exec(input.trim());
  if (match === null) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = UNITS[match[2] ?? ''];
  if (unit === undefined || !Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  return amount * unit;
}

/** Whether `requested` is within `max`; a missing bound never caps, a missing request is capped. */
export function withinDuration(
  requested: unknown,
  max: string | undefined,
): boolean {
  const cap = parseDuration(max);
  if (cap === undefined) {
    return true;
  }
  const seconds = parseDuration(requested);
  return seconds !== undefined && seconds <= cap;
}
