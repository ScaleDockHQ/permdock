export function isThenable<T>(
  value: T | PromiseLike<T>,
): value is PromiseLike<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/** Settles a promise nobody awaits, so its rejection is not reported as unhandled. */
export function ignoreRejection(value: PromiseLike<unknown>): void {
  void Promise.resolve(value).then(undefined, () => undefined);
}
