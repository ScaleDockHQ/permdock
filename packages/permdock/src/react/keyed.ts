import { useState } from "react";

/**
 * `create()` once per distinct `inputs`, held in state: React may drop a
 * `useMemo` value and rebuild it, and a rebuilt store loses its answers,
 * polls and followed snapshot.
 */
export function useKeyed<T>(create: () => T, inputs: readonly unknown[]): T {
  const [held, setHeld] = useState(() => ({ inputs, value: create() }));
  if (
    held.inputs.length === inputs.length &&
    held.inputs.every((input, index) => Object.is(input, inputs[index]))
  ) {
    return held.value;
  }
  const next = { inputs, value: create() };
  setHeld(next);
  return next.value;
}
