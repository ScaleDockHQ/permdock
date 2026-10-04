import type { Grantee, GranteeInput } from "./grantee.ts";

import { isReadonlyArray } from "./compact.ts";

/** One named approver, by principal id. */
export type UserApprover = { readonly kind: "user"; readonly id: string };

/**
 * Who may approve: a subject-only grantee, a `relation()` the approver holds
 * on the requested row (checked when the verdict is given), or `user(id)`.
 * A list matches an approver who satisfies every item.
 */
export type Approver = Grantee | UserApprover;

export type ApproverInput =
  | GranteeInput
  | UserApprover
  | readonly ApproverInput[];

/** A named approver for `approval.by`, matched on the approver's principal id. */
export function user(id: string): UserApprover {
  if (typeof id !== "string" || id === "") {
    throw new Error("PermDock: user() needs a non-empty principal id");
  }
  return Object.freeze({ kind: "user" as const, id });
}

export function isUserApprover(value: unknown): value is UserApprover {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "user"
  );
}

export function flattenApprovers(
  input: Approver | readonly Approver[] | undefined,
): readonly Approver[] {
  if (input === undefined) {
    return [];
  }
  if (isReadonlyArray(input)) {
    // SAFETY: isReadonlyArray does not narrow the element type; the only array form is Approver[].
    return input as readonly Approver[];
  }
  // SAFETY: undefined and arrays returned above, so input is a single Approver.
  return [input as Approver];
}
