import type { SubjectRef } from "../../src/conditions/refs.ts";

/**
 * `base[key]` as a `SubjectRef`: the ref proxy answers every safe key, but
 * `noUncheckedIndexedAccess` widens an index-signature read to `| undefined`.
 */
export function refAt(
  base: SubjectRef,
  ...keys: readonly string[]
): SubjectRef {
  let ref = base;
  for (const key of keys) {
    const next = ref[key];
    if (next === undefined) {
      throw new Error(`No ref at ${ref.ref}.${key}`);
    }
    ref = next;
  }
  return ref;
}
