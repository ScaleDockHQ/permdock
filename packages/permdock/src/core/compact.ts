export function compact<R extends object>(value: object): R {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const next = (value as Record<string, unknown>)[key];
    if (next !== undefined) {
      result[key] = next;
    }
  }
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
