// ISO 8601 date or date-time, including the Postgres text form
// (`2020-01-02 10:00:00+00`). Anything else is never an instant.
const ISO_INSTANT =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}(?::?\d{2})?)?)?$/u;

/**
 * Milliseconds since the epoch for an ISO 8601 date or date-time, or
 * `undefined`. A date-time without a zone and a bare date are UTC, the same
 * in memory, in the ORM compilers and in generated SQL.
 */
export function isoInstant(value: string): number | undefined {
  const match = ISO_INSTANT.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, day, time, zone] = match;
  let offset = zone ?? (time === undefined ? "" : "Z");
  if (/^[+-]\d{2}$/u.test(offset)) {
    offset = `${offset}:00`;
  } else if (/^[+-]\d{4}$/u.test(offset)) {
    offset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  }
  const parsed = Date.parse(
    time === undefined ? `${day}` : `${day}T${time}${offset}`,
  );
  return Number.isNaN(parsed) ? undefined : parsed;
}
