/** A rune-backed value, so tests can change what a getter reads. */
export function cell<T>(initial: T): { value: T } {
  let value = $state(initial);
  return {
    get value(): T {
      return value;
    },
    set value(next: T) {
      value = next;
    },
  };
}

/** Deeply reactive props for `mount`, so a test can change them later. */
export function reactive<T extends object>(initial: T): T {
  const state = $state(initial);
  return state;
}
