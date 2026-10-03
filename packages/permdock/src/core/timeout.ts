/** Aborts after `ms`, or earlier when `signal` aborts. */
export function timeoutSignal(
  ms: number,
  signal?: AbortSignal | null,
): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  return signal === undefined || signal === null
    ? deadline
    : AbortSignal.any([signal, deadline]);
}
