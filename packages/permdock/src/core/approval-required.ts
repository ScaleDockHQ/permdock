import type { Grant } from "./policy-types.ts";

export function requiresApproval(
  approval: Grant["approval"] | undefined,
): boolean {
  return approval !== undefined;
}
