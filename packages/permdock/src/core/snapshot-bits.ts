/**
 * `keys` as a base64url bit set over `table`: bit `i` is `table[i]`, trailing
 * zero bytes dropped. `undefined` when a key is not in `table`.
 */
export function toBits(
  keys: readonly string[],
  table: readonly string[],
): string | undefined {
  const at = new Map(table.map((key, index) => [key, index]));
  const bytes: number[] = [];
  for (const key of keys) {
    const index = at.get(key);
    if (index === undefined) {
      return undefined;
    }
    const byte = index >> 3;
    while (bytes.length <= byte) {
      bytes.push(0);
    }
    bytes[byte] = (bytes[byte] ?? 0) | (1 << (index & 7));
  }
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");
}

/** The keys of `table` a `toBits` string sets. Throws on a bit past its end. */
export function fromBits(bits: string, table: readonly string[]): string[] {
  if (!/^[\w-]*$/u.test(bits)) {
    throw new Error("PermDock: snapshot bit set is not base64url");
  }
  const text = atob(bits.replaceAll("-", "+").replaceAll("_", "/"));
  const keys: string[] = [];
  for (let byte = 0; byte < text.length; byte += 1) {
    const value = text.codePointAt(byte) ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((value & (1 << bit)) === 0) {
        continue;
      }
      const key = table[byte * 8 + bit];
      if (key === undefined) {
        throw new Error("PermDock: snapshot bit set is longer than its table");
      }
      keys.push(key);
    }
  }
  return keys;
}
