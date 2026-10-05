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

/** Whether two ids are the same id once both are read as text; a missing id matches nothing. */
export function sameId(left: unknown, right: unknown): boolean {
  const text = idText(left);
  return text !== undefined && text === idText(right);
}
