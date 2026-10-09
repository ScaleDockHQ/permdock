import type { Snapshot } from "../core/interfaces.ts";

/** A compact JWS: three non-empty dot-separated parts. */
export function isJws(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

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
