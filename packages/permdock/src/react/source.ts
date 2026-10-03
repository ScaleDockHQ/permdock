import type { Snapshot } from "../core/interfaces.ts";

export function isPromiseLike(
  value: unknown,
): value is PromiseLike<Snapshot | string> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
