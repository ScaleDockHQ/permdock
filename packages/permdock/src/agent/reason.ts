import type { Decision } from "../core/decision.ts";
import type { Permission } from "../core/permissions.ts";

import { describe } from "../core/describe.ts";
import { deniedMessage } from "../core/errors.ts";

export function modelReason(
  decision: Decision,
  permission: Permission | undefined,
  subjectId: string | undefined,
): string {
  if (decision.outcome === "denied") {
    return deniedMessage(
      permission?.key ?? "unknown",
      subjectId,
      decision.denials,
      decision.alternatives.map((leaf) => leaf.key),
    );
  }
  return describe(decision).detail;
}

export function unmappedReason(toolName: string): string {
  return `Denied: unmapped tool ${toolName}.`;
}

export function thrownReason(toolName: string): string {
  return `Denied: ${toolName} failed closed.`;
}
