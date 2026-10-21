import type { Decision } from "./decision.ts";
import type { Permission } from "./permission-types.ts";
import type { Policy } from "./policy-types.ts";
import type { Subject } from "./subject.ts";

import { compact } from "./compact.ts";
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
  approvalMessage,
  deniedMessage,
} from "./errors.ts";
import { getResource } from "./permission-registry.ts";

/**
 * `assert`'s outcome: the granted decision, or the error a refusal throws after
 * `onDenied` runs.
 */
export function assertDecision(
  policy: Policy,
  subject: Subject,
  permission: Permission,
  data: unknown,
  decision: Decision,
  onDenied: ((decision: Decision) => void) | undefined,
): Extract<Decision, { readonly outcome: "granted" }> {
  if (decision.outcome === "granted") {
    return decision;
  }
  if (onDenied !== undefined) {
    onDenied(decision);
  }
  const resource = getResource(policy.permissions, permission.resource);
  // SAFETY: data is a non-null object checked in the condition; the read value stays unknown.
  const resourceId =
    data !== null && typeof data === "object"
      ? (data as Record<string, unknown>)[resource?.id ?? "id"]
      : undefined;
  const resourceRef = compact<{ readonly type: string; readonly id?: string }>({
    type: permission.resource,
    // oxlint-disable-next-line typescript/no-base-to-string -- the audit id is the configured id column as text, whatever its type
    id: resourceId === undefined ? undefined : String(resourceId),
  });
  if (decision.outcome === "approval-required") {
    throw new PermDockApprovalRequiredError({
      decision,
      permission: permission.key,
      scope: permission.scope,
      resource: resourceRef,
      message: approvalMessage(permission.key, decision.reason, decision.token),
    });
  }
  if (decision.denials.some((denial) => denial.reason === "validation")) {
    const detail = decision.denials[0]?.detail;
    if (detail instanceof PermDockValidationError) {
      throw detail;
    }
  }
  throw new PermDockDeniedError({
    decision,
    permission: permission.key,
    scope: permission.scope,
    resource: resourceRef,
    subject,
    message: deniedMessage(
      permission.key,
      subject.principal?.id,
      decision.denials,
      decision.alternatives.map((leaf) => leaf.key),
    ),
    ...(data === undefined || resource === undefined
      ? {}
      : { disclosure: resource.disclosure }),
  });
}
