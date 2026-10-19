/** UTF-16 code-unit order, never `localeCompare`: generated SQL must match byte for byte on every machine. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function byKey(
  [a]: readonly [string, unknown],
  [b]: readonly [string, unknown],
): number {
  return byCodeUnit(a, b);
}
