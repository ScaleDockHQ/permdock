import type { Decision } from "../core/decision.ts";

/** What an `onError` sink receives next to the thrown error. */
export type BetterSupabaseErrorContext = {
  /** The key of the permission being checked, when the request named one. */
  readonly permission: string | null;
  /** The active tenant the check ran in, or `null`. */
  readonly tenant: string | null;
};

/**
 * Receives an error a permission check threw. The check still denies; a sink
 * that throws is ignored.
 */
export type BetterSupabaseOnError = (
  error: unknown,
  context: BetterSupabaseErrorContext,
) => void;

/** `PermDock denied <key>: <first denial reason>.` */
export function deniedMessage(
  key: string,
  decision: Extract<Decision, { outcome: "denied" }>,
): string {
  const why = decision.denials[0]?.reason;
  return why === undefined
    ? `PermDock denied ${key}.`
    : `PermDock denied ${key}: ${why}.`;
}

export function report(
  sink: BetterSupabaseOnError | undefined,
  error: unknown,
  context: BetterSupabaseErrorContext,
): void {
  if (sink === undefined) return;
  try {
    sink(error, context);
  } catch {
    // A failing sink must not turn a denial into a throw (invariant 1).
  }
}
