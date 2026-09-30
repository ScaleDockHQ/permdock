export function compact<R extends object>(value: object): R {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    // SAFETY: key comes from Object.keys(value), so it is an own string key of the object.
    const next = (value as Record<string, unknown>)[key];
    if (next !== undefined) {
      result[key] = next;
    }
  }
  // SAFETY: R is the caller's shape for value; the copy only omits keys whose value is undefined.
  return result as R;
}

/** `Array.isArray` that keeps `readonly T[]` instead of widening to `any[]`. */
export function isReadonlyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** The element of a one-element list, else `undefined`. */
export function sole<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}
