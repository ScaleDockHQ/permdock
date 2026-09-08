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
