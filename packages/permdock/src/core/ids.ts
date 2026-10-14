/**
 * The canonical text of a scope or object id: a non-empty string as is, a
 * finite number or a bigint as its decimal text (a `bigint` key column read
 * through supabase-js arrives as a number), anything else none.
 */
export function idText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value === "" ? undefined : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

const MAX_ID = 256;
const MAX_ENTRIES = 64;

/** A wire id: a non-empty string of at most 256 characters. */
export function isId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= MAX_ID
  );
}

/** A non-empty list of at most 64 wire ids, deduplicated, else `undefined`. */
export function idList(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ENTRIES ||
    !value.every(isId)
  ) {
    return undefined;
  }
  return [...new Set(value)];
}

/** Whether two ids are the same id once both are read as text; a missing id matches nothing. */
export function sameId(left: unknown, right: unknown): boolean {
  const text = idText(left);
  return text !== undefined && text === idText(right);
}
