import type { Grantee, GranteeInput } from "./grantee.ts";
import type { Permission } from "./permissions.ts";

import { isReadonlyArray } from "./compact.ts";

/** One named approver, by principal id. */
export type UserApprover = { readonly kind: "user"; readonly id: string };

/**
 * Whoever holds `permission` in the request's tenant, through any role,
 * custom roles included. Checked only through verdict facts
 * (`ApprovalVerdict.permissions`) that the handler computes from the
 * approver's own instance.
 */
export type PermissionApprover = {
  readonly kind: "permission";
  readonly permission: string;
};

/** An approver who matches at least one item; an item that is a list matches when every entry does. */
export type AnyOfApprover = {
  readonly kind: "any-of";
  readonly of: readonly (Approver | readonly Approver[])[];
};

/**
 * Who may approve: a subject-only grantee, a `relation()` the approver holds
 * on the requested row (checked when the verdict is given), `user(id)`,
 * `holder(permission)`, or `anyOf(...)`. A list (or `allOf(...)`) matches an
 * approver who satisfies every item.
 */
export type Approver =
  | Grantee
  | UserApprover
  | PermissionApprover
  | AnyOfApprover;

export type ApproverInput =
  | GranteeInput
  | UserApprover
  | PermissionApprover
  | {
      readonly kind: "any-of";
      readonly of: readonly ApproverInput[];
    }
  | readonly ApproverInput[];

/** Approves when the approver holds `permission` in the request's tenant (any role, custom roles included). */
export function holder(permission: Permission): PermissionApprover {
  const key: unknown = permission?.key;
  if (typeof key !== "string" || key === "") {
    throw new Error("PermDock: holder() needs a permission");
  }
  return Object.freeze({ kind: "permission" as const, permission: key });
}

/** Approves when the approver matches any one of `items`. */
export function anyOf(...items: readonly ApproverInput[]): {
  readonly kind: "any-of";
  readonly of: readonly ApproverInput[];
} {
  if (items.length === 0) {
    throw new Error("PermDock: anyOf() needs at least one approver");
  }
  return Object.freeze({
    kind: "any-of" as const,
    of: Object.freeze([...items]),
  });
}

/** Approves when the approver matches every one of `items`; the same as a list. */
export function allOf(
  ...items: readonly ApproverInput[]
): readonly ApproverInput[] {
  if (items.length === 0) {
    throw new Error("PermDock: allOf() needs at least one approver");
  }
  return Object.freeze([...items]);
}

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

/** Every approver `input` names, inside `anyOf` groups too, for reading facts and labels. */
export function approverLeaves(
  input: Approver | readonly Approver[] | undefined,
): readonly Approver[] {
  return flattenApprovers(input).flatMap((item) =>
    item.kind === "any-of"
      ? item.of.flatMap((entry) => approverLeaves(entry))
      : [item],
  );
}

export function isPermissionApprover(
  value: unknown,
): value is PermissionApprover {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "permission"
  );
}

export function isAnyOfInput(value: unknown): value is {
  readonly kind: "any-of";
  readonly of: readonly ApproverInput[];
} {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "any-of"
  );
}
