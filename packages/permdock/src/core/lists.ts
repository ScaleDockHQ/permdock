/**
 * `Array.isArray` for `readonly T[] | T` unions: the built-in narrows a
 * readonly array to `any[]`, this keeps `readonly T[]`.
 */
export function isReadonlyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** The element of a one-element list; `undefined` when empty or longer. */
export function sole<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}
