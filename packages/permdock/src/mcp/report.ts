import type { McpAuthInfo, McpErrorContext, McpOnError } from "./types.ts";

/**
 * Sends `error` to the `onError` sink. The check still refuses; a sink that
 * throws is ignored (invariant 1).
 */
export function report(
  sink: McpOnError | undefined,
  error: unknown,
  context: McpErrorContext,
): void {
  if (sink === undefined) return;
  try {
    sink(error, context);
  } catch {
    // A failing sink must not turn a refusal into a throw.
  }
}

/** The call's tenant for an error report; `null` when it has none or throws. */
export async function reportedTenant(
  tenant:
    | string
    | ((
        authInfo: McpAuthInfo,
      ) => string | undefined | Promise<string | undefined>)
    | undefined,
  authInfo: McpAuthInfo | undefined,
): Promise<string | null> {
  if (typeof tenant !== "function") {
    return tenant ?? null;
  }
  try {
    return (await tenant(authInfo ?? {})) ?? null;
  } catch {
    return null;
  }
}
