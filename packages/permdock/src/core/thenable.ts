export function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'then' in value &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}
