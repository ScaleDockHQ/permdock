/**
 * Orders strings by UTF-16 code unit, the same in every locale and runtime,
 * so sorted output is byte-stable where `localeCompare` would follow the ICU
 * build.
 */
export function byCodePoint(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
