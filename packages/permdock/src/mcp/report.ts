import type { McpOnError } from "./types.ts";

/**
 * Sends `error` to the `onError` sink. The check still refuses; a sink that
 * throws is ignored (invariant 1).
 */
export function report(
  sink: McpOnError | undefined,
  error: unknown,
  context: { readonly permission: string | null; readonly name: string },
): void {
  if (sink === undefined) return;
  try {
    sink(error, context);
  } catch {
    // A failing sink must not turn a refusal into a throw.
  }
}
