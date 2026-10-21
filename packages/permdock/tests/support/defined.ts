/** `value`, or a thrown error when it is `null` or `undefined`. */
export function defined<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(`expected a value, got ${String(value)}`);
  }
  return value;
}
